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
exports.registerChatParticipant = registerChatParticipant;
const vscode = __importStar(require("vscode"));
/**
 * Chat participant @qwen — routes all requests through our registered
 * LanguageModelChatProvider (custom-llm vendor), so VS Code handles the
 * streaming protocol correctly and the mgt.clearMarks error cannot occur.
 */
function registerChatParticipant(context) {
    const participant = vscode.chat.createChatParticipant('custom-llm.qwen', async (request, chatContext, stream, token) => {
        // Get models registered by our provider
        const models = await vscode.lm.selectChatModels({ vendor: 'custom-llm' });
        if (!models || models.length === 0) {
            stream.markdown('⚠️ **No models available.**\n\n' +
                'Configure your endpoint first:\n' +
                '`Ctrl+Shift+P` → **Custom LLM: Configure endpoint & API key**');
            return;
        }
        // Pick the model: if the first word of the prompt matches a known model id, use it.
        // Otherwise fall back to the first available model.
        let model = models[0];
        const firstWord = request.prompt.trim().split(/\s+/)[0];
        const byId = models.find(m => m.id === firstWord);
        if (byId) {
            model = byId;
        }
        const userPrompt = byId
            ? request.prompt.trim().slice(firstWord.length).trim()
            : request.prompt;
        // Build message history
        const messages = [];
        for (const turn of chatContext.history) {
            if (turn instanceof vscode.ChatRequestTurn) {
                messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
            }
            else if (turn instanceof vscode.ChatResponseTurn) {
                const text = turn.response
                    .filter((p) => p instanceof vscode.ChatResponseMarkdownPart)
                    .map(p => p.value.value)
                    .join('');
                if (text) {
                    messages.push(vscode.LanguageModelChatMessage.Assistant(text));
                }
            }
        }
        messages.push(vscode.LanguageModelChatMessage.User(userPrompt || request.prompt));
        // Show which model is responding
        stream.markdown(`*[${model.name}]*\n\n`);
        try {
            // Use vscode.lm API — goes through CustomLlmProvider.provideLanguageModelChatResponse()
            // This is the correct path; direct HTTP calls caused the mgt.clearMarks error.
            const response = await model.sendRequest(messages, {}, token);
            for await (const chunk of response.stream) {
                if (chunk instanceof vscode.LanguageModelTextPart) {
                    stream.markdown(chunk.value);
                }
            }
        }
        catch (err) {
            if (err instanceof vscode.LanguageModelError) {
                stream.markdown(`\n\n❌ **${err.code}:** ${err.message}`);
            }
            else if (err instanceof Error && err.name !== 'AbortError') {
                stream.markdown(`\n\n❌ ${err.message}`);
            }
        }
    });
    participant.iconPath = new vscode.ThemeIcon('sparkle');
    context.subscriptions.push(participant);
    return participant;
}
//# sourceMappingURL=participant.js.map