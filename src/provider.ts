import * as vscode from 'vscode';
import { ApiKeyStore } from './secrets';

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
  providerId?: string;   // slug reference to ProviderConfig.id
  providerUrl?: string;  // @deprecated – fallback for pre-migration configs
  maxInputTokens: number;
  maxOutputTokens: number;
  imageInput?: boolean;      // vision support; undefined = assume yes (see provideLanguageModelChatInformation)
  hidden?: boolean;          // kept out of the model picker, but still usable if already selected
  thinkingEffort?: string;   // per-model override: "auto"|"off"|"low"|"medium"|"high"
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
  maxTokensSent: number;
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
      max_tokens: stats.maxTokensSent,
      finish_reason: stats.finishReason,
    }));
  }

  if (stats.contentChunks === 0 && stats.toolCallChunks === 0) {
    if (stats.reasoningChunks > 0) {
      // Report what was actually sent, not what is configured — those used to
      // differ silently because requests were capped at 8192, so the advice
      // "increase maxOutputTokens" was given to people who already had.
      const configured = model.maxOutputTokens;
      const mismatch = configured !== stats.maxTokensSent
        ? ` (configured maxOutputTokens=${configured})`
        : '';
      logLine(
        `[${reqId}] ⚠️  EMPTY CONTENT — model produced ${stats.reasoningChars} chars of reasoning but 0 chars of content. ` +
        `Likely cause: the output budget sent to the model (max_tokens=${stats.maxTokensSent}${mismatch}) was consumed by reasoning. ` +
        `Raise maxOutputTokens for "${model.id}" in the customLlm.models setting — 32768+ suits most reasoning models.`
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

function isDataPartLike(value: unknown): value is { data: Uint8Array; mimeType: string } {
  return isObject(value)
    && typeof value.mimeType === 'string'
    && (value.data instanceof Uint8Array || ArrayBuffer.isView(value.data as ArrayBufferView));
}

function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/** Data parts also carry text/JSON payloads (LanguageModelDataPart.text / .json). */
function isTextualMime(mimeType: string): boolean {
  return mimeType.startsWith('text/')
    || mimeType === 'application/json'
    || mimeType.endsWith('+json');
}

function decodeTextData(data: Uint8Array): string {
  try {
    return new TextDecoder().decode(data);
  } catch {
    return '';
  }
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

    // Images produced by a tool (e.g. a screenshot) cannot ride along in the
    // `tool` message: the OpenAI schema — and DashScope, which follows it —
    // only accepts a plain string there. They are carried over into a
    // follow-up `user` message instead, which is the only role that takes
    // image_url parts. Without this the screenshot was silently dropped and
    // the model answered "I cannot view this image".
    const carriedImages: Array<{ data: Uint8Array; mimeType: string }> = [];

    for (const tr of toolResultParts) {
      const resultTexts: string[] = [];
      const imagesBefore = carriedImages.length;

      for (const p of tr.content) {
        if (p instanceof vscode.LanguageModelTextPart) {
          resultTexts.push(p.value);
        } else if (p instanceof vscode.LanguageModelDataPart || isDataPartLike(p)) {
          const dp = p as { data: Uint8Array; mimeType: string };
          if (isImageMime(dp.mimeType)) {
            carriedImages.push(dp);
          } else if (isTextualMime(dp.mimeType)) {
            resultTexts.push(decodeTextData(dp.data));
          } else {
            logLine(`[toOpenAIMessages] tool result data part ignored (mime=${dp.mimeType})`);
          }
        } else if (isTextPartLike(p)) {
          resultTexts.push(p.value);
        }
      }

      const imagesHere = carriedImages.length - imagesBefore;
      let content = resultTexts.join('');
      if (!content && imagesHere > 0) {
        // An empty tool message makes some endpoints reject the turn outright.
        content = imagesHere === 1
          ? '[Tool returned an image — see the next message.]'
          : `[Tool returned ${imagesHere} images — see the next message.]`;
      }
      result.push({ role: 'tool', content, tool_call_id: tr.callId });
    }

    // Message-level images alongside tool calls/results were dropped by the
    // old "no tool parts" guard — carry them over the same way.
    if (toolCallParts.length > 0 || toolResultParts.length > 0) {
      carriedImages.push(...imageParts);
    }

    if (carriedImages.length > 0) {
      const contentParts: OpenAIContentPart[] = [
        { type: 'text', text: carriedImages.length === 1
          ? 'Image output from the preceding tool call:'
          : 'Image output from the preceding tool call(s):' },
      ];
      for (const img of carriedImages) {
        contentParts.push({ type: 'image_url', image_url: { url: toDataUrl(img.data, img.mimeType) } });
      }
      result.push({ role: 'user', content: contentParts });
      logLine(`[toOpenAIMessages] forwarded ${carriedImages.length} tool-result image(s) as a user message`);
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

/** True when any outgoing message actually carries image content. */
function containsImageContent(messages: readonly OpenAIMessage[]): boolean {
  return messages.some(m =>
    Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')
  );
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Used only when a model carries no usable maxOutputTokens value. */
export const FALLBACK_MAX_OUTPUT_TOKENS = 8192;

/**
 * The `max_tokens` to send for a model.
 *
 * Requests used to be clamped with `Math.min(model.maxOutputTokens, 8192)`,
 * which made the setting unreachable above 8192 — reasoning models then burned
 * the whole budget on thinking and returned empty content, and even the
 * extension's own defaults (qwen3.6-plus at 65536, kimi-k2.5 at 32768) could
 * never be used. The configured value is now authoritative; the fallback only
 * covers a missing or nonsensical one.
 */
export function resolveMaxOutputTokens(configured: number | undefined): number {
  const value = Number(configured);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : FALLBACK_MAX_OUTPUT_TOKENS;
}

function calculateDelay(attempt: number, initialDelayMs: number, maxDelayMs: number): number {
  const exponentialDelay = initialDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay;
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

function isRetryableError(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 504);
}

/**
 * Whether a 400 body really says "this model can't take images".
 *
 * Deliberately strict: the message must name an image-ish concept *and* phrase
 * it as a rejection. Matching bare "unsupported" / "does not support" made any
 * unrelated 400 ("unsupported parameter: max_tokens", "does not support tool
 * choice") surface as a vision error and made working multimodal models look
 * text-only. Callers must additionally confirm images were actually sent.
 */
function looksLikeVisionRejection(message: string): boolean {
  const lower = message.toLowerCase();
  const mentionsImage = /\b(image|images|image_url|vision|multi-?modal|visual)\b/.test(lower);
  if (!mentionsImage) { return false; }
  return /(not support|unsupported|not allowed|not accept|invalid|cannot|can't|only support)/.test(lower);
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
  requestHasImages = false
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

      // Only claim "no image support" when we actually sent an image and the
      // server said so — otherwise let the real error through verbatim.
      if (status === 400 && requestHasImages && looksLikeVisionRejection(errorMessage)) {
        throw new Error(
          `Custom LLM: This model does not support image input.\n` +
          `Use a multimodal model (e.g. qwen-vl-max) for image analysis, or set ` +
          `"imageInput": false on this model in customLlm.models to stop VS Code sending images to it.\n` +
          `Details: ${errorMessage}`
        );
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

// ── Thinking effort ────────────────────────────────────────────────────────────

type ThinkingEffort = 'auto' | 'off' | 'low' | 'medium' | 'high';

/**
 * Translate the user's thinking-effort setting into provider-specific request
 * body fields.  Returns an object that is spread into the request body.
 *
 * Supported families:
 *   - Qwen (qwen* prefix) / DASHSCOPE → enable_thinking + thinking_budget
 *   - OpenAI o-series (o1/o3/o4), DeepSeek-V4 chat, GPT-5 → reasoning_effort
 *   - Everything else → {} (silently ignored)
 *
 * Budget mapping:  low=1024  medium=8192  high=min(32768, maxOutputTokens)
 */
function buildThinkingParams(
  modelId: string,
  effort: string,
  maxOutputTokens: number
): Record<string, unknown> {
  if (effort === 'auto') { return {}; }

  const id = modelId.toLowerCase();

  // ── Qwen / DashScope ────────────────────────────────────────────────────────
  if (id.startsWith('qwen')) {
    if (effort === 'off') {
      return { enable_thinking: false };
    }
    const budgetMap: Record<string, number> = { low: 1024, medium: 8192, high: 32768 };
    const budget = Math.min(budgetMap[effort] ?? 8192, maxOutputTokens - 1);
    return { enable_thinking: true, thinking_budget: Math.max(budget, 512) };
  }

  // ── OpenAI reasoning / DeepSeek-V4 ─────────────────────────────────────────
  const usesReasoningEffort =
    /^(o1|o3|o4|gpt-5|deepseek-v4|deepseek-chat)/.test(id) ||
    id.includes('reasoning');
  if (usesReasoningEffort) {
    if (effort === 'off' || effort === 'low')    { return { reasoning_effort: 'low' }; }
    if (effort === 'medium')                      { return { reasoning_effort: 'medium' }; }
    if (effort === 'high')                        { return { reasoning_effort: 'high' }; }
  }

  // ── Everything else ─────────────────────────────────────────────────────────
  return {};
}


export class CustomLlmProvider implements vscode.LanguageModelChatProvider {

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  constructor(private readonly apiKeys: ApiKeyStore, private statusBar?: vscode.StatusBarItem) {
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
    const allModels: ModelConfig[] = cfg.get('models') ?? [];
    const providers: Array<{ id?: string; name: string; baseUrl: string; apiKey?: string }> = cfg.get('providers') ?? [];

    // Hiding is a picker-level concern only: the entry stays in customLlm.models
    // and provideLanguageModelChatResponse still resolves it, so a chat already
    // pinned to a hidden model keeps working and unhiding is just a flag flip.
    const modelConfigs = allModels.filter(m => m.hidden !== true);
    const hiddenCount = allModels.length - modelConfigs.length;

    if (options.silent) {
      const hasUsableProvider = providers.some(p => !!p.baseUrl);
      if (!hasUsableProvider || modelConfigs.length === 0) {
        logLine(`provideLanguageModelChatInformation(silent=true): no providers/visible models configured, returning []`);
        return [];
      }
    }

    // Build lookup by both id (new) and baseUrl (fallback for pre-migration models)
    const nameMap = new Map<string, string>([
      ...providers.filter(p => p.id).map(p => [p.id, p.name] as [string, string]),
      ...providers.map(p => [p.baseUrl, p.name] as [string, string]),
    ]);

    const result = modelConfigs.map((m) => {
      const providerLabel = nameMap.get(m.providerId ?? '')
        ?? nameMap.get(m.providerUrl ?? '')
        ?? 'Custom LLM';
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
          // VS Code gates image attachment on this flag: leaving it unset made
          // every model — including genuinely multimodal ones — look text-only,
          // so screenshots from tools never reached the endpoint. We cannot
          // detect vision support for an arbitrary OpenAI-compatible endpoint,
          // so assume yes unless discovery or the user says otherwise. A model
          // that really can't take images answers with a clear 400.
          imageInput: m.imageInput !== false,
        },
      };
    });
    logLine(
      `provideLanguageModelChatInformation(silent=${options.silent}): returning ${result.length} models` +
      (hiddenCount > 0 ? ` (${hiddenCount} hidden)` : '')
    );
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
    const providers: Array<{ id?: string; name: string; baseUrl: string; apiKey?: string }> = cfg.get('providers') ?? [];
    const modelCfg = models.find(m => m.id === model.id);
    if (!modelCfg) {
      logLine(`WARN: no ModelConfig found for model.id='${model.id}'. Configured model ids: [${models.map(m => m.id).join(', ')}]`);
    }

    let provider = modelCfg
      ? (providers.find(p => p.id && p.id === modelCfg.providerId)        // primary: slug match
        ?? providers.find(p => p.baseUrl === modelCfg.providerUrl))        // fallback: URL match (pre-migration)
      : undefined;
    if (!provider && providers.length === 1) {
      provider = providers[0];
      if (modelCfg) {
        logLine(`[${model.id}] providerId mismatch but only 1 provider configured — using it`);
      }
    }
    if (!provider) {
      const msg = `Custom LLM: model '${model.id}' has no matching provider. Run "Custom LLM: Refresh model list from API" to fix.`;
      logLine(`✗ ${msg}`);
      throw new Error(msg);
    }

    const baseUrl: string = provider.baseUrl;
    // Keys live in SecretStorage; `provider.apiKey` only still exists on a
    // hand-edited settings.json that startup migration has not swept up yet.
    const apiKey: string =
      (provider.id ? await this.apiKeys.get(provider.id) : '') || provider.apiKey || '';
    if (!apiKey) {
      logLine(`[${model.id}] no API key for provider '${provider.id ?? provider.baseUrl}' — sending unauthenticated request`);
    }

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

    const safeMaxTokens = resolveMaxOutputTokens(model.maxOutputTokens);

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
    const hasImages = containsImageContent(oaiMessages);

    // ── Thinking effort ────────────────────────────────────────────────────────
    // Per-model override wins over global setting; "auto" means send nothing.
    const globalEffort: string =
      vscode.workspace.getConfiguration('customLlm').get<string>('thinkingEffort') ?? 'auto';
    const effort: string = modelCfg?.thinkingEffort ?? globalEffort;
    const thinkingParams = buildThinkingParams(model.id, effort, safeMaxTokens);
    if (effort !== 'auto') {
      logLine(`[setup] thinking effort=${effort}  model=${model.id}  params=${JSON.stringify(thinkingParams)}`);
    }

    const body = JSON.stringify({
      model: model.id,
      messages: oaiMessages,
      stream: true,
      max_tokens: safeMaxTokens,
      stream_options: { include_usage: true },
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...thinkingParams,
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
      maxTokensSent: safeMaxTokens,
    };
    const startedAt = Date.now();

    logLine(`[${reqId}] → POST ${baseUrl}/chat/completions  model=${model.id}  msgs=${messages.length}  tools=${tools?.length ?? 0}  images=${hasImages ? 'yes' : 'no'}  max_tokens=${safeMaxTokens}`);
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
      }, DEFAULT_RETRY_CONFIG, hasImages);
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
