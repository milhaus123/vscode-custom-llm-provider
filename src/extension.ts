import * as vscode from 'vscode';
import { CustomLlmProvider } from './provider';
import { registerChatParticipant } from './participant';

interface ModelConfig {
  id: string;
  name: string;
  maxInputTokens: number;
  maxOutputTokens: number;
}

/**
 * Sync our models into github.copilot.chat.customOAIModels so they appear
 * directly in the Copilot Chat model picker (native BYOK path).
 * This runs alongside registerLanguageModelChatProvider which handles
 * the actual request routing (auth, retry, streaming).
 */
async function syncCopilotPickerModels(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('customLlm');
  const baseUrl: string = cfg.get('baseUrl') ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const apiKey: string = cfg.get('apiKey') ?? '';
  const models: ModelConfig[] = cfg.get('models') ?? [];

  // Build the customOAIModels map. We route through our own provider
  // (registerLanguageModelChatProvider), so requiresAPIKey is false here —
  // auth is added by CustomLlmProvider.provideLanguageModelChatResponse().
  const customOAIModels: Record<string, object> = {};
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
    await vscode.workspace.getConfiguration('github.copilot.chat').update(
      'customOAIModels',
      customOAIModels,
      vscode.ConfigurationTarget.Global
    );
  } catch {
    // Silently ignore — older VS Code versions without this setting
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new CustomLlmProvider();

  // Register the provider under our vendor ID declared in package.json
  const registration = vscode.lm.registerLanguageModelChatProvider(
    'custom-llm',
    provider
  );

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
    if (baseUrl === undefined) return; // user cancelled

    await cfg.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);

    const apiKey = await vscode.window.showInputBox({
      title: 'Custom LLM — API Key',
      value: cfg.get('apiKey') ?? '',
      prompt: 'API key (sk-…). Leave empty if the endpoint does not require authentication.',
      password: true,
    });
    if (apiKey === undefined) return;

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
  registerChatParticipant(context);

  context.subscriptions.push(registration, configureCmd, cfgWatcher, provider);
}

export function deactivate() {
  // VS Code disposes subscriptions automatically
}
