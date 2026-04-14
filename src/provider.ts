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

/** Convert a raw image Uint8Array + mimeType to a base64 data URL */
function toDataUrl(data: Uint8Array, mimeType: string): string {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < data.length; i += chunkSize) {
    binary += String.fromCharCode(...data.subarray(i, i + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
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
        // Image or binary data attached to the message
        if (part.mimeType.startsWith('image/')) {
          imageParts.push(part);
        }
        // Non-image data parts (json, etc.) are silently skipped — models don't support them
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCallParts.push(part);
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        toolResultParts.push(part);
      }
    }

    // Tool results → individual 'tool' role messages (one per call result)
    for (const tr of toolResultParts) {
      const content = tr.content
        .map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : ''))
        .join('');
      result.push({ role: 'tool', content, tool_call_id: tr.callId });
    }

    // Assistant message with tool calls
    if (toolCallParts.length > 0) {
      result.push({
        role: 'assistant',
        content: textParts.join('') || null,
        tool_calls: toolCallParts.map((tc) => ({
          id: tc.callId,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        })),
      });
    } else if (toolResultParts.length === 0) {
      // Build content — either plain string (no images) or multipart array (with images)
      if (imageParts.length > 0) {
        const contentParts: OpenAIContentPart[] = [];
        if (textParts.length > 0) {
          contentParts.push({ type: 'text', text: textParts.join('') });
        }
        for (const img of imageParts) {
          contentParts.push({
            type: 'image_url',
            image_url: { url: toDataUrl(img.data, img.mimeType) },
          });
        }
        result.push({
          role: isUser ? 'user' : 'assistant',
          content: contentParts,
        });
      } else {
        result.push({
          role: isUser ? 'user' : 'assistant',
          content: textParts.join(''),
        });
      }
    }
  }

  return result;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function calculateDelay(attempt: number, initialDelayMs: number, maxDelayMs: number): number {
  // Exponential backoff with jitter
  const exponentialDelay = initialDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay;
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

function isRetryableError(status: number): boolean {
  // Retry on 429 (rate limit), 500, 502, 503, 504 (server errors)
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

      // Try to extract a human-readable message from JSON error responses
      let errorMessage = errorBody;
      try {
        const parsed = JSON.parse(errorBody);
        // OpenAI-compatible: { error: { message } } or { message } or { msg }
        errorMessage =
          parsed?.error?.message ??
          parsed?.message ??
          parsed?.msg ??
          errorBody;
      } catch { /* not JSON — use raw body */ }

      if (status === 401) {
        throw new Error(
          'Custom LLM: Invalid or missing API key.\n' +
          'Open Command Palette (Ctrl+Shift+P) → "Custom LLM: Manage providers" to update your API key.\n' +
          `Details: ${errorMessage}`
        );
      }

      // Image/vision not supported by this model
      if (status === 400) {
        const lower = errorMessage.toLowerCase();
        if (
          lower.includes('image') ||
          lower.includes('vision') ||
          lower.includes('multimodal') ||
          lower.includes('does not support') ||
          lower.includes('unsupported') ||
          lower.includes('invalid content type')
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
        throw error; // Don't retry on cancellation
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

  constructor() {
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('customLlm')) {
        this._onDidChange.fire();
      }
    });
  }

  // Called by VS Code during model discovery
  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    const cfg = vscode.workspace.getConfiguration('customLlm');
    const modelConfigs: ModelConfig[] = cfg.get('models') ?? [];
    const providers: Array<{ name: string; baseUrl: string }> = cfg.get('providers') ?? [];

    // Build a map: providerUrl → provider name for display
    const nameMap = new Map(providers.map(p => [p.baseUrl, p.name]));

    return modelConfigs.map((m) => {
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
        capabilities: {
          toolCalling: true,
          imageInput: true,
        },
      };
    });
  }

  // Response is streamed via progress.report(), return value is void
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('customLlm');

    // Look up which provider this model belongs to
    const models: ModelConfig[] = cfg.get('models') ?? [];
    const providers: Array<{ name: string; baseUrl: string; apiKey: string }> = cfg.get('providers') ?? [];
    const modelCfg = models.find(m => m.id === model.id);

    // Find provider by matching providerUrl; fall back to first provider
    const provider = modelCfg
      ? providers.find(p => p.baseUrl === modelCfg.providerUrl) ?? providers[0]
      : providers[0];

    const baseUrl: string = provider?.baseUrl ?? '';
    const apiKey: string  = provider?.apiKey  ?? '';

    // Prepare tools if provided
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

    const body = JSON.stringify({
      model: model.id,
      messages: toOpenAIMessages(messages),
      stream: true,
      max_tokens: model.maxOutputTokens,
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-DashScope-SSE': 'enable',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const abortController = new AbortController();
    const cancelDisposable = token.onCancellationRequested(() => abortController.abort());

    let response: Response;
    try {
      response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: abortController.signal,
      });
    } finally {
      cancelDisposable.dispose();
    }

    if (!response.ok || !response.body) {
      const err = await response.text();
      throw new Error(`Custom LLM (${response.status}): ${err}`);
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';

    // Accumulate tool call chunks — OpenAI streams arguments in pieces
    // key = index (0, 1, 2…), value = accumulated call data
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

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            // Flush any remaining tool calls
            for (const [, call] of pendingToolCalls) {
              try {
                const input = JSON.parse(call.arguments || '{}');
                progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
              } catch {
                progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, {}));
              }
            }
            return;
          }

          try {
            const chunk: OpenAIStreamChunk = JSON.parse(data);
            const choice = chunk.choices[0];
            if (!choice) continue;

            // Text content — filter out <think>…</think> blocks emitted by Qwen3
            const content = choice.delta?.content;
            if (content) {
              if (thinkState === 'pass') {
                progress.report(new vscode.LanguageModelTextPart(content));
              } else {
                thinkBuf += content;
                if (thinkState === 'detect') {
                  const trimmed = thinkBuf.trimStart();
                  if (trimmed.startsWith('<think>')) {
                    thinkState = 'skip';
                    thinkBuf = trimmed.slice('<think>'.length);
                  } else if (trimmed.length > 0 && !('<think>'.startsWith(trimmed.slice(0, 7)))) {
                    // Definitely not a <think> block — emit buffered content and switch to pass
                    thinkState = 'pass';
                    progress.report(new vscode.LanguageModelTextPart(thinkBuf));
                    thinkBuf = '';
                  } else if (thinkBuf.length > 30) {
                    // Safety: too much buffering without deciding — emit and pass through
                    thinkState = 'pass';
                    progress.report(new vscode.LanguageModelTextPart(thinkBuf));
                    thinkBuf = '';
                  }
                } else { // 'skip'
                  const endIdx = thinkBuf.indexOf('</think>');
                  if (endIdx !== -1) {
                    thinkState = 'pass';
                    // Strip leading newlines that models often add after </think>
                    const after = thinkBuf.slice(endIdx + '</think>'.length).replace(/^\n{1,2}/, '');
                    thinkBuf = '';
                    if (after) progress.report(new vscode.LanguageModelTextPart(after));
                  } else if (thinkBuf.length > 200) {
                    // Keep only the tail so we can still detect </think> split across chunks
                    thinkBuf = thinkBuf.slice(-20);
                  }
                }
              }
            }

            // Tool call chunks — accumulate by index
            if (choice.delta?.tool_calls) {
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

            // When model signals it's done calling tools — report all accumulated calls
            if (choice.finish_reason === 'tool_calls') {
              for (const [, call] of pendingToolCalls) {
                try {
                  const input = JSON.parse(call.arguments || '{}');
                  progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
                } catch {
                  progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, {}));
                }
              }
              pendingToolCalls.clear();
              return;
            }
          } catch {
            // Malformed SSE chunk — skip
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // Token counting — first parameter is the model (not text!)
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
