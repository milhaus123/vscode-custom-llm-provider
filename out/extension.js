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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const provider_1 = require("./provider");
const participant_1 = require("./participant");
/**
 * Sync our models into github.copilot.chat.customOAIModels so they appear
 * directly in the Copilot Chat model picker (native BYOK path).
 * This runs alongside registerLanguageModelChatProvider which handles
 * the actual request routing (auth, retry, streaming).
 */
async function syncCopilotPickerModels() {
    const cfg = vscode.workspace.getConfiguration('customLlm');
    const baseUrl = cfg.get('baseUrl') ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const apiKey = cfg.get('apiKey') ?? '';
    const models = cfg.get('models') ?? [];
    // Build the customOAIModels map. We route through our own provider
    // (registerLanguageModelChatProvider), so requiresAPIKey is false here —
    // auth is added by CustomLlmProvider.provideLanguageModelChatResponse().
    const customOAIModels = {};
    for (const model of models) {
        customOAIModels[model.id] = {
            name: model.name,
            url: baseUrl,
            toolCalling: true,
            maxInputTokens: model.maxInputTokens,
            maxOutputTokens: model.maxOutputTokens,
            requiresAPIKey: apiKey.length > 0,
        };
    }
    try {
        await vscode.workspace.getConfiguration('github.copilot.chat').update('customOAIModels', customOAIModels, vscode.ConfigurationTarget.Global);
    }
    catch {
        // Silently ignore — older VS Code versions without this setting
    }
}
function activate(context) {
    const provider = new provider_1.CustomLlmProvider();
    // Register the provider under our vendor ID declared in package.json
    const registration = vscode.lm.registerLanguageModelChatProvider('custom-llm', provider);
    // Notify VS Code after a short delay so the model picker is ready to receive the event.
    // Firing immediately can cause "e is not iterable" in Copilot Chat's model picker init.
    setTimeout(() => provider.notifyModelsChanged(), 2000);
    // Sync models into Copilot Chat's native picker (customOAIModels setting)
    syncCopilotPickerModels();
    // Management command — opened when user clicks the gear icon next to the provider
    const configureCmd = vscode.commands.registerCommand('custom-llm.configure', async () => {
        const cfg = vscode.workspace.getConfiguration('customLlm');
        const baseUrl = await vscode.window.showInputBox({
            title: 'Custom LLM — Base URL',
            value: cfg.get('baseUrl') ?? 'https://coding-intl.dashscope.aliyuncs.com/v1',
            prompt: 'Base URL of the OpenAI-compatible endpoint',
        });
        if (baseUrl === undefined)
            return; // user cancelled
        await cfg.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
        const apiKey = await vscode.window.showInputBox({
            title: 'Custom LLM — API Key',
            value: cfg.get('apiKey') ?? '',
            prompt: 'API key (sk-…). Leave empty if the endpoint does not require authentication.',
            password: true,
        });
        if (apiKey === undefined)
            return;
        await cfg.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
        // Re-sync picker after config change
        await syncCopilotPickerModels();
        vscode.window.showInformationMessage('Custom LLM: configuration saved.');
    });
    // Re-sync picker whenever customLlm settings change externally
    const cfgWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('customLlm')) {
            syncCopilotPickerModels();
            provider.notifyModelsChanged();
        }
    });
    // Chat participant @qwen — uses vscode.lm API to route through our provider
    (0, participant_1.registerChatParticipant)(context);
    context.subscriptions.push(registration, configureCmd, cfgWatcher, provider);
}
function deactivate() {
    // VS Code disposes subscriptions automatically
}
//# sourceMappingURL=extension.js.map