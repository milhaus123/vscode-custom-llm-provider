"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomLlmProvider = void 0;
const vscode = __importStar(require("vscode"));
const DEFAULT_RETRY_CONFIG = {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 10000,
};
function toOpenAIMessages(messages) {
    const result = [];
    for (const msg of messages) {
        const isUser = msg.role === vscode.LanguageModelChatMessageRole.User;
        const textParts = [];
        const toolCallParts = [];
        const toolResultParts = [];
        for (const part of msg.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                textParts.push(part.value);
            }
            else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCallParts.push(part);
            }
            else if (part instanceof vscode.LanguageModelToolResultPart) {
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
        }
        else if (toolResultParts.length === 0) {
            // Plain text message — only add if there were no tool results (already handled above)
            result.push({
                role: isUser ? 'user' : 'assistant',
                content: textParts.join(''),
            });
        }
    }
    return result;
}
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
function calculateDelay(attempt, initialDelayMs, maxDelayMs) {
    // Exponential backoff with jitter
    const exponentialDelay = initialDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * 0.3 * exponentialDelay;
    return Math.min(exponentialDelay + jitter, maxDelayMs);
}
function isRetryableError(status) {
    // Retry on 429 (rate limit), 500, 502, 503, 504 (server errors)
    return status === 429 || (status >= 500 && status <= 504);
}
async function fetchWithRetry(url, init, retryConfig = DEFAULT_RETRY_CONFIG) {
    let lastError = null;
    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
        try {
            const response = await fetch(url, init);
            if (response.ok) {
                return response;
            }
            const status = response.status;
            const errorBody = await response.text().catch(() => 'Unknown error');
            if (!isRetryableError(status)) {
                throw new Error(`Custom LLM (${status}): ${errorBody}`);
            }
            lastError = new Error(`Custom LLM (${status}): ${errorBody}`);
            if (attempt < retryConfig.maxRetries) {
                const delay = calculateDelay(attempt, retryConfig.initialDelayMs, retryConfig.maxDelayMs);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        catch (error) {
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
class CustomLlmProvider {
    _onDidChange = new vscode.EventEmitter();
    onDidChangeLanguageModelChatInformation = this._onDidChange.event;
    constructor() {
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('customLlm')) {
                this._onDidChange.fire();
            }
        });
    }
    // VS Code volá tuto metodu při discovery modelů
    provideLanguageModelChatInformation(options, _token) {
        const cfg = vscode.workspace.getConfiguration('customLlm');
        const modelConfigs = cfg.get('models') ?? [];
        const baseUrl = cfg.get('baseUrl') ?? '';
        const providerLabel = baseUrl.includes('dashscope') ? 'Alibaba DashScope' : 'Custom LLM';
        return modelConfigs.map((m) => ({
            id: m.id,
            name: m.name,
            family: m.id.split(/[-:]/)[0],
            version: '1',
            detail: providerLabel,
            maxInputTokens: m.maxInputTokens,
            maxOutputTokens: m.maxOutputTokens,
            // Show in the Copilot Chat model picker dropdown
            showInModelPicker: true,
            capabilities: {
                toolCalling: true,
            },
        }));
    }
    // Response se posílá přes progress.report(), návratová hodnota je void
    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        const cfg = vscode.workspace.getConfiguration('customLlm');
        const baseUrl = cfg.get('baseUrl') ?? '';
        const apiKey = cfg.get('apiKey') ?? '';
        // Prepare tools if provided
        let tools;
        if (options.tools && options.tools.length > 0) {
            tools = options.tools.map(tool => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description || '',
                    parameters: tool.inputSchema || { type: 'object', properties: {} }
                }
            }));
        }
        const body = JSON.stringify({
            model: model.id,
            messages: toOpenAIMessages(messages),
            stream: true,
            ...(tools && tools.length > 0 ? { tools } : {}),
        });
        const headers = {
            'Content-Type': 'application/json',
            'X-DashScope-SSE': 'enable',
        };
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }
        const abortController = new AbortController();
        const cancelDisposable = token.onCancellationRequested(() => abortController.abort());
        let response;
        try {
            response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body,
                signal: abortController.signal,
            });
        }
        finally {
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
        const pendingToolCalls = new Map();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (token.isCancellationRequested)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:'))
                        continue;
                    const data = trimmed.slice(5).trim();
                    if (data === '[DONE]') {
                        // Flush any remaining tool calls
                        for (const [, call] of pendingToolCalls) {
                            try {
                                const input = JSON.parse(call.arguments || '{}');
                                progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
                            }
                            catch {
                                progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, {}));
                            }
                        }
                        return;
                    }
                    try {
                        const chunk = JSON.parse(data);
                        const choice = chunk.choices[0];
                        if (!choice)
                            continue;
                        // Text content
                        const content = choice.delta?.content;
                        if (content) {
                            progress.report(new vscode.LanguageModelTextPart(content));
                        }
                        // Tool call chunks — accumulate by index
                        if (choice.delta?.tool_calls) {
                            for (const tc of choice.delta.tool_calls) {
                                const idx = tc.index ?? 0;
                                if (!pendingToolCalls.has(idx)) {
                                    pendingToolCalls.set(idx, { id: tc.id ?? `call_${idx}`, name: '', arguments: '' });
                                }
                                const entry = pendingToolCalls.get(idx);
                                if (tc.id)
                                    entry.id = tc.id;
                                if (tc.function?.name)
                                    entry.name += tc.function.name;
                                if (tc.function?.arguments)
                                    entry.arguments += tc.function.arguments;
                            }
                        }
                        // When model signals it's done calling tools — report all accumulated calls
                        if (choice.finish_reason === 'tool_calls') {
                            for (const [, call] of pendingToolCalls) {
                                try {
                                    const input = JSON.parse(call.arguments || '{}');
                                    progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
                                }
                                catch {
                                    progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, {}));
                                }
                            }
                            pendingToolCalls.clear();
                            return;
                        }
                    }
                    catch {
                        // Malformed SSE chunk — skip
                    }
                }
            }
        }
        finally {
            reader.releaseLock();
        }
    }
    // Token counting — první parametr je model (ne text!)
    async provideTokenCount(_model, text, _token) {
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
exports.CustomLlmProvider = CustomLlmProvider;
//# sourceMappingURL=provider.js.map