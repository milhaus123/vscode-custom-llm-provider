import * as vscode from 'vscode';

// OpenAI content part — used for multimodal (vision) messages
type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | OpenAIContentPart[];
  // Assistant tool calls
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  // Tool result identifier
  tool_call_id?: string;
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIStreamChunk {
  choices: Array<{
    delta: {
      content?: string;
      // Some reasoning-capable endpoints (Qwen3 thinking, DeepSeek-R1, QwQ, etc.)
      // stream the chain-of-thought separately in this field. Copilot doesn't
      // render thinking, so we consume + log but never forward it.
      reasoning_content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
      text_tokens?: number;
    };
  };
}

interface ModelConfig {
  id: string;
  name: string;
  providerUrl?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
}

interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
};

// Lazy-initialized output channel — visible in View → Output → "Custom LLM".
let _logChannel: vscode.OutputChannel | undefined;
function log(): vscode.OutputChannel {
  if (!_logChannel) {
    _logChannel = vscode.window.createOutputChannel('Custom LLM');
  }
  return _logChannel;
}
export function logLine(msg: string): void {
  log().appendLine(`[${new Date().toISOString()}] ${msg}`);
}

interface RequestStats {
  contentChunks: number;
  contentChars: number;
  reasoningChunks: number;
  reasoningChars: number;
  toolCallChunks: number;
  finishReason: string | null;
  malformedChunks: number;
  summaryLogged: boolean;
  usage: { promptTokens: number; completionTokens: number; reasoningTokens: number } | null;
}

function logSummary(
  reqId: string,
  stats: RequestStats,
  startedAt: number,
  model: vscode.LanguageModelChatInformation,
  reason: string = 'done'
): void {
  if (stats.summaryLogged) return;
  stats.summaryLogged = true;
  const ms = Date.now() - startedAt;
  const parts = [
    `[${reqId}] ← ${reason}`,
    `model=${model.id}`,
    `${ms}ms`,
    `content=${stats.contentChunks}ch/${stats.contentChars}c`,
    `reasoning=${stats.reasoningChunks}ch/${stats.reasoningChars}c`,
    `tools=${stats.toolCallChunks}`,
    `finish=${stats.finishReason ?? '∅'}`,
  ];
  if (stats.malformedChunks > 0) parts.push(`malformed=${stats.malformedChunks}`);
  logLine(parts.join('  '));

  // Structured JSON usage line — same format as LiteLLM extension
  if (stats.usage) {
    log().appendLine(JSON.stringify({
      event: 'token_usage',
      reqId,
      model: model.id,
      ms,
      prompt_tokens: stats.usage.promptTokens,
      completion_tokens: stats.usage.completionTokens,
      reasoning_tokens: stats.usage.reasoningTokens,
      finish_reason: stats.finishReason,
    }));
  }

  if (stats.contentChunks === 0 && stats.toolCallChunks === 0) {
    if (stats.reasoningChunks > 0) {
      logLine(
        `[${reqId}] ⚠️  EMPTY CONTENT — model produced ${stats.reasoningChars} chars of reasoning but 0 chars of content. ` +
        `Likely cause: max_tokens (${model.maxOutputTokens}) exhausted inside reasoning. ` +
        `Increase maxOutputTokens for "${model.id}" to 32768+ in settings.`
      );
    } else {
      logLine(
        `[${reqId}] ⚠️  EMPTY RESPONSE — no content, reasoning, or tool calls received. ` +
        `Check upstream model configuration / network.`
      );
    }
  }
}

/** Convert a raw image Uint8Array + mimeType to a base64 data URL */
function toDataUrl(data: Uint8Array, mimeType: string): string {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < data.length; i += chunkSize) {
    binary += String.fromCharCode(...data.subarray(i, i + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTextPartLike(value: unknown): value is { value: string } {
  return isObject(value) && typeof value.value === 'string';
}

function isToolCallPartLike(value: unknown): value is { callId: string; name: string; input?: unknown } {
  return isObject(value) && typeof value.callId === 'string' && typeof value.name === 'string';
}

function isToolResultPartLike(value: unknown): value is { callId: string; content: unknown[] } {
  return isObject(value) && typeof value.callId === 'string' && Array.isArray(value.content);
}

function partDebugInfo(part: unknown): string {
  if (!isObject(part)) {
    return `type=${typeof part}`;
  }
  const ctor = typeof part.constructor?.name === 'string' ? part.constructor.name : 'Object';
  const keys = Object.keys(part).slice(0, 10).join(',');
  return `ctor=${ctor} keys=[${keys}]`;
}

function toOpenAIMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const msg of messages) {
    const isUser = msg.role === vscode.LanguageModelChatMessageRole.User;

    const textParts: string[] = [];
    const imageParts: vscode.LanguageModelDataPart[] = [];
    const toolCallParts: vscode.LanguageModelToolCallPart[] = [];
    const toolResultParts: vscode.LanguageModelToolResultPart[] = [];

    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        textParts.push(part.value);
      } else if (part instanceof vscode.LanguageModelDataPart) {
        if (part.mimeType.startsWith('image/')) {
          imageParts.push(part);
        }
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCallParts.push(part);
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        toolResultParts.push(part);
      } else if (isToolCallPartLike(part)) {
        logLine(`[toOpenAIMessages] structurally recognized tool call part: ${partDebugInfo(part)}`);
        toolCallParts.push(part as unknown as vscode.LanguageModelToolCallPart);
      } else if (isToolResultPartLike(part)) {
        logLine(`[toOpenAIMessages] structurally recognized tool result part: ${partDebugInfo(part)}`);
        toolResultParts.push(part as unknown as vscode.LanguageModelToolResultPart);
      } else {
        logLine(`[toOpenAIMessages] unknown message part ignored: ${partDebugInfo(part)}`);
      }
    }

    if (toolCallParts.length > 0) {
      result.push({
        role: 'assistant',
        content: textParts.join('') || null,
        tool_calls: toolCallParts.map((tc) => ({
          id: tc.callId,
          type: 'function',
          function: { name: tc.name, arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}) },
        })),
      });
    }

    for (const tr of toolResultParts) {
      const content = tr.content
        .map((p) => {
          if (p instanceof vscode.LanguageModelTextPart) return p.value;
          if (isTextPartLike(p)) return p.value;
          return '';
        })
        .join('');
      result.push({ role: 'tool', content, tool_call_id: tr.callId });
    }

    if (toolCallParts.length === 0 && toolResultParts.length === 0) {
      if (imageParts.length > 0) {
        const contentParts: OpenAIContentPart[] = [];
        if (textParts.length > 0) {
          contentParts.push({ type: 'text', text: textParts.join('') });
        }
        for (const img of imageParts) {
          contentParts.push({ type: 'image_url', image_url: { url: toDataUrl(img.data, img.mimeType) } });
        }
        result.push({ role: isUser ? 'user' : 'assistant', content: contentParts });
      } else {
        result.push({ role: isUser ? 'user' : 'assistant', content: textParts.join('') });
      }
    }
  }

  return result;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function calculateDelay(attempt: number, initialDelayMs: number, maxDelayMs: number): number {
  const exponentialDelay = initialDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay;
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

function isRetryableError(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 504);
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);

      if (response.ok) {
        return response;
      }

      const status = response.status;
      const errorBody = await response.text().catch(() => 'Unknown error');

      let errorMessage = errorBody;
      try {
        const parsed = JSON.parse(errorBody);
        errorMessage = parsed?.error?.message ?? parsed?.message ?? parsed?.msg ?? errorBody;
      } catch { /* not JSON */ }

      if (status === 401) {
        throw new Error(
          'Custom LLM: Invalid or missing API key.\n' +
          'Open Command Palette (Ctrl+Shift+P) → "Custom LLM: Manage providers" to update your API key.\n' +
          `Details: ${errorMessage}`
        );
      }

      if (status === 400) {
        const lower = errorMessage.toLowerCase();
        if (
          lower.includes('image') || lower.includes('vision') || lower.includes('multimodal') ||
          lower.includes('does not support') || lower.includes('unsupported') || lower.includes('invalid content type')
        ) {
          throw new Error(
            `Custom LLM: This model does not support image input.\n` +
            `Use a multimodal model (e.g. qwen-vl-max) for image analysis.\n` +
            `Details: ${errorMessage}`
          );
        }
      }

      if (!isRetryableError(status)) {
        throw new Error(`Custom LLM (${status}): ${errorMessage}`);
      }

      lastError = new Error(`Custom LLM (${status}): ${errorMessage}`);

      if (attempt < retryConfig.maxRetries) {
        const delay = calculateDelay(attempt, retryConfig.initialDelayMs, retryConfig.maxDelayMs);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }

      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < retryConfig.maxRetries) {
        const delay = calculateDelay(attempt, retryConfig.initialDelayMs, retryConfig.maxDelayMs);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error('Request failed after all retries');
}


export class CustomLlmProvider implements vscode.LanguageModelChatProvider {

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  constructor(private statusBar?: vscode.StatusBarItem) {
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('customLlm')) {
        this._onDidChange.fire();
      }
    });
  }

  provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    const cfg = vscode.workspace.getConfiguration('customLlm');
    const modelConfigs: ModelConfig[] = cfg.get('models') ?? [];
    const providers: Array<{ name: string; baseUrl: string; apiKey?: string }> = cfg.get('providers') ?? [];

    if (options.silent) {
      const hasUsableProvider = providers.some(p => !!p.baseUrl);
      if (!hasUsableProvider || modelConfigs.length === 0) {
        logLine(`provideLanguageModelChatInformation(silent=true): no providers/models configured, returning []`);
        return [];
      }
    }

    const nameMap = new Map(providers.map(p => [p.baseUrl, p.name]));

    const result = modelConfigs.map((m) => {
      const providerLabel = nameMap.get(m.providerUrl ?? '')
        ?? (m.providerUrl?.includes('dashscope') ? 'Alibaba DashScope' : 'Custom LLM');
      return {
        id: m.id,
        name: m.name,
        family: m.id.split(/[-:.]/)[0],
        version: '1',
        detail: providerLabel,
        maxInputTokens: m.maxInputTokens,
        maxOutputTokens: m.maxOutputTokens,
        showInModelPicker: true,
        capabilities: { toolCalling: true },
      };
    });
    logLine(`provideLanguageModelChatInformation(silent=${options.silent}): returning ${result.length} models`);
    return result;
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    logLine(`← provideLanguageModelChatResponse called: model=${model.id}, msgs=${messages.length}, tools=${options.tools?.length ?? 0}`);
    const cfg = vscode.workspace.getConfiguration('customLlm');

    const models: ModelConfig[] = cfg.get('models') ?? [];
    const providers: Array<{ name: string; baseUrl: string; apiKey: string }> = cfg.get('providers') ?? [];
    const modelCfg = models.find(m => m.id === model.id);
    if (!modelCfg) {
      logLine(`WARN: no ModelConfig found for model.id='${model.id}'. Configured model ids: [${models.map(m => m.id).join(', ')}]`);
    }

    let provider = modelCfg
      ? providers.find(p => p.baseUrl === modelCfg.providerUrl)
      : undefined;
    if (!provider && providers.length === 1) {
      provider = providers[0];
      if (modelCfg) {
        logLine(`[${model.id}] providerUrl mismatch but only 1 provider configured — using it`);
      }
    }
    if (!provider) {
      const msg = `Custom LLM: model '${model.id}' has no matching provider. Run "Custom LLM: Refresh model list from API" to fix.`;
      logLine(`✗ ${msg}`);
      throw new Error(msg);
    }

    const baseUrl: string = provider.baseUrl;
    const apiKey: string  = provider.apiKey ?? '';

    let tools: OpenAITool[] | undefined;
    if (options.tools && options.tools.length > 0) {
      tools = options.tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: (tool.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} }
        }
      }));
    }

    const safeMaxTokens = Math.min(model.maxOutputTokens, 8192);

    for (let mi = 0; mi < messages.length; mi++) {
      const m = messages[mi];
      const partKinds = m.content.map((p) => {
        if (p instanceof vscode.LanguageModelTextPart) return 'TextPart';
        if (p instanceof vscode.LanguageModelDataPart) return 'DataPart';
        if (p instanceof vscode.LanguageModelToolCallPart) return 'ToolCallPart';
        if (p instanceof vscode.LanguageModelToolResultPart) return 'ToolResultPart';
        if (isToolCallPartLike(p)) return 'ToolCallLike';
        if (isToolResultPartLike(p)) return 'ToolResultLike';
        return partDebugInfo(p);
      });
      logLine(`[incoming] msg[${mi}] role=${m.role} parts=${partKinds.join(', ')}`);
    }

    const oaiMessages = toOpenAIMessages(messages);
    const body = JSON.stringify({
      model: model.id,
      messages: oaiMessages,
      stream: true,
      max_tokens: safeMaxTokens,
      stream_options: { include_usage: true },
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (baseUrl.includes('dashscope')) {
      headers['X-DashScope-SSE'] = 'enable';
    }
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const abortController = new AbortController();
    const cancelDisposable = token.onCancellationRequested(() => abortController.abort());

    const reqId = Math.random().toString(36).slice(2, 8);
    const stats = {
      contentChunks: 0,
      contentChars: 0,
      reasoningChunks: 0,
      reasoningChars: 0,
      toolCallChunks: 0,
      finishReason: null as string | null,
      malformedChunks: 0,
      summaryLogged: false,
      usage: null as { promptTokens: number; completionTokens: number; reasoningTokens: number } | null,
    };
    const startedAt = Date.now();

    logLine(`[${reqId}] → POST ${baseUrl}/chat/completions  model=${model.id}  msgs=${messages.length}  tools=${tools?.length ?? 0}  max_tokens=${safeMaxTokens}`);
    oaiMessages.forEach((m: any, i: number) => {
      const contentLen = typeof m.content === 'string' ? m.content.length : Array.isArray(m.content) ? `${m.content.length}parts` : 0;
      logLine(`[${reqId}] msg[${i}] role=${m.role} contentLen=${contentLen} tool_calls=${m.tool_calls?.length ?? 0} tool_call_id=${m.tool_call_id ?? '-'}`);
    });
    if (tools && tools.length > 0) {
      logLine(`[${reqId}] tools (${tools.length}): ${tools.map((t: any) => t.function?.name).join(', ')}`);
    }

    this.statusBar && (this.statusBar.text = '$(sync~spin) Custom LLM');
    let response: Response;
    try {
      response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: abortController.signal,
      });
    } catch (e) {
      logLine(`[${reqId}] ✗ fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      this.statusBar && (this.statusBar.text = '$(warning) Custom LLM');
      throw e;
    } finally {
      cancelDisposable.dispose();
    }

    if (!response.ok || !response.body) {
      const err = await response.text();
      logLine(`[${reqId}] ✗ HTTP ${response.status}: ${err.substring(0, 4000)}`);
      throw new Error(`Custom LLM (${response.status}): ${err}`);
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';

    const IDLE_MS = 60_000;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        logLine(`[${reqId}] ✗ idle timeout (${IDLE_MS}ms) — aborting`);
        abortController.abort();
      }, IDLE_MS);
    };
    resetIdle();

    const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    // State machine for filtering <think>...</think> blocks (Qwen3 extended thinking).
    // 'detect' = waiting to see whether stream starts with <think>;
    // 'skip'   = inside a think block, discarding content until </think>;
    // 'pass'   = normal content, pass directly to progress.
    let thinkState: 'detect' | 'skip' | 'pass' = 'detect';
    let thinkBuf = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (token.isCancellationRequested) break;
        resetIdle();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            for (const [, call] of pendingToolCalls) {
              if (!call.name) {
                logLine(`[${reqId}] ⚠ skipping tool_call with empty name (id=${call.id})`);
                continue;
              }
              try {
                const input = JSON.parse(call.arguments || '{}');
                logLine(`[${reqId}] tool_call (DONE): id=${call.id} name=${call.name}`);
                progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
              } catch (e) {
                logLine(`[${reqId}] tool_call bad JSON (DONE): id=${call.id} name=${call.name} err=${e instanceof Error ? e.message : e}`);
                progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, {}));
              }
            }
            logSummary(reqId, stats, startedAt, model);
            return;
          }

          try {
            const chunk: OpenAIStreamChunk = JSON.parse(data);

            if (chunk.usage) {
              stats.usage = {
                promptTokens:     chunk.usage.prompt_tokens     ?? 0,
                completionTokens: chunk.usage.completion_tokens ?? 0,
                reasoningTokens:  chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
              };
            }

            const choice = chunk.choices?.[0];
            if (!choice) continue;

            if (choice.finish_reason) {
              stats.finishReason = choice.finish_reason;
            }

            const reasoning = choice.delta?.reasoning_content;
            if (reasoning) {
              stats.reasoningChunks++;
              stats.reasoningChars += reasoning.length;
            }

            const content = choice.delta?.content;
            if (content) {
              stats.contentChunks++;
              stats.contentChars += content.length;

              if (thinkState === 'pass') {
                progress.report(new vscode.LanguageModelTextPart(content));
              } else {
                thinkBuf += content;
                if (thinkState === 'detect') {
                  const tb = thinkBuf.trimStart();
                  if (tb.startsWith('<think>')) {
                    thinkState = 'skip';
                    thinkBuf = tb.slice('<think>'.length);
                  } else if (tb.length > 0 && !('<think>'.startsWith(tb.slice(0, 7)))) {
                    thinkState = 'pass';
                    progress.report(new vscode.LanguageModelTextPart(thinkBuf));
                    thinkBuf = '';
                  } else if (thinkBuf.length > 30) {
                    thinkState = 'pass';
                    progress.report(new vscode.LanguageModelTextPart(thinkBuf));
                    thinkBuf = '';
                  }
                } else { // 'skip'
                  const endIdx = thinkBuf.indexOf('</think>');
                  if (endIdx !== -1) {
                    thinkState = 'pass';
                    const after = thinkBuf.slice(endIdx + '</think>'.length).replace(/^\n{1,2}/, '');
                    thinkBuf = '';
                    if (after) progress.report(new vscode.LanguageModelTextPart(after));
                  } else if (thinkBuf.length > 200) {
                    thinkBuf = thinkBuf.slice(-20);
                  }
                }
              }
            }

            if (choice.delta?.tool_calls) {
              stats.toolCallChunks++;
              for (const tc of choice.delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!pendingToolCalls.has(idx)) {
                  pendingToolCalls.set(idx, { id: tc.id ?? `call_${idx}`, name: '', arguments: '' });
                }
                const entry = pendingToolCalls.get(idx)!;
                if (tc.id) entry.id = tc.id;
                if (tc.function?.name) entry.name += tc.function.name;
                if (tc.function?.arguments) entry.arguments += tc.function.arguments;
              }
            }

            if (choice.finish_reason === 'tool_calls') {
              for (const [, call] of pendingToolCalls) {
                if (!call.name) {
                  logLine(`[${reqId}] ⚠ skipping tool_call with empty name (id=${call.id})`);
                  continue;
                }
                try {
                  const input = JSON.parse(call.arguments || '{}');
                  logLine(`[${reqId}] tool_call: id=${call.id} name=${call.name} args=${call.arguments.slice(0, 200)}`);
                  progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
                } catch (e) {
                  logLine(`[${reqId}] tool_call bad JSON: id=${call.id} name=${call.name} err=${e instanceof Error ? e.message : e}`);
                  progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, {}));
                }
              }
              pendingToolCalls.clear();
              logSummary(reqId, stats, startedAt, model, 'tool_calls');
              return;
            }
          } catch {
            stats.malformedChunks++;
          }
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name !== 'AbortError') {
        logLine(`[${reqId}] ✗ stream error: ${e.message}`);
      }
      logSummary(reqId, stats, startedAt, model, e instanceof Error ? e.name : 'error');
      this.statusBar && (this.statusBar.text = '$(warning) Custom LLM');
      throw e;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      reader.releaseLock();
      this.statusBar && (this.statusBar.text = '$(check) Custom LLM');
    }
    logSummary(reqId, stats, startedAt, model, token.isCancellationRequested ? 'cancelled' : 'done');
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    if (typeof text === 'string') {
      return estimateTokens(text);
    }
    const combined = text.content
      .map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : ''))
      .join('');
    return estimateTokens(combined);
  }

  notifyModelsChanged() {
    this._onDidChange.fire();
  }

  dispose() {
    this._onDidChange.dispose();
  }
}
