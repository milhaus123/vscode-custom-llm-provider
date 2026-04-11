import * as vscode from 'vscode';
import { CustomLlmProvider } from './provider';
import { registerChatParticipant } from './participant';

interface ModelConfig {
  id: string;
  name: string;
  maxInputTokens: number;
  maxOutputTokens: number;
}

// The canonical default model list — single source of truth.
// When a new model is added here, existing users will get it automatically
// on next extension activation (via migrateModels).
const DEFAULT_MODELS: ModelConfig[] = [
  { id: 'qwen3-coder-plus',     name: 'Qwen3 Coder Plus',  maxInputTokens: 131072,  maxOutputTokens: 8192  },
  { id: 'qwen3-coder-next',     name: 'Qwen3 Coder Next',  maxInputTokens: 131072,  maxOutputTokens: 8192  },
  { id: 'qwen3-max-2026-01-23', name: 'Qwen3 Max',         maxInputTokens: 131072,  maxOutputTokens: 8192  },
  { id: 'qwen3.5-plus',         name: 'Qwen3.5 Plus',      maxInputTokens: 1000000, maxOutputTokens: 16384 },
  { id: 'qwen3.6-plus',         name: 'Qwen3.6 Plus',      maxInputTokens: 1000000, maxOutputTokens: 65536 },
  { id: 'glm-5',                name: 'GLM-5',             maxInputTokens: 204800,  maxOutputTokens: 16384 },
  { id: 'glm-4.7',              name: 'GLM-4.7',           maxInputTokens: 131072,  maxOutputTokens: 8192  },
  { id: 'kimi-k2.5',            name: 'Kimi K2.5',         maxInputTokens: 262144,  maxOutputTokens: 32768 },
  { id: 'MiniMax-M2.5',         name: 'MiniMax M2.5',      maxInputTokens: 262144,  maxOutputTokens: 8192  },
];

/**
 * Merge DEFAULT_MODELS into the user's saved model list:
 * - Adds any default model not yet present (by id).
 * - Updates maxInputTokens / maxOutputTokens for existing default models
 *   when the stored values differ (e.g. after a token-limit correction).
 * - Preserves any user-added custom models untouched.
 * Returns true if settings were updated.
 */
async function migrateModels(): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('customLlm');
  const userModels: ModelConfig[] = cfg.get('models') ?? [];

  const defaultById = new Map(DEFAULT_MODELS.map(m => [m.id, m]));
  let changed = false;

  // Update token limits for existing default models if they differ
  const updated = userModels.map(m => {
    const def = defaultById.get(m.id);
    if (!def) { return m; } // custom model — leave untouched
    if (m.maxInputTokens !== def.maxInputTokens || m.maxOutputTokens !== def.maxOutputTokens) {
      changed = true;
      return { ...m, maxInputTokens: def.maxInputTokens, maxOutputTokens: def.maxOutputTokens };
    }
    return m;
  });

  // Append brand-new default models not yet in user list
  const existingIds = new Set(updated.map(m => m.id));
  const newModels = DEFAULT_MODELS.filter(m => !existingIds.has(m.id));
  if (newModels.length > 0) { changed = true; }

  if (!changed) { return false; }

  await cfg.update('models', [...updated, ...newModels], vscode.ConfigurationTarget.Global);
  return true;
}

/**
 * Sync our models into github.copilot.chat.customOAIModels so they appear
 * directly in the Copilot Chat model picker (native BYOK path).
 */
async function syncCopilotPickerModels(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('customLlm');
  const baseUrl: string = cfg.get('baseUrl') ?? 'https://coding-intl.dashscope.aliyuncs.com/v1';
  const apiKey: string = cfg.get('apiKey') ?? '';
  const models: ModelConfig[] = cfg.get('models') ?? DEFAULT_MODELS;

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

  // On activation: merge any new default models into user settings,
  // then sync the Copilot picker. This ensures existing users automatically
  // get newly added models after updating the extension.
  migrateModels().then((migrated) => {
    if (migrated) {
      vscode.window.showInformationMessage(
        'Custom LLM: New models have been added to your model list.'
      );
    }
    syncCopilotPickerModels();
  });

  // Notify VS Code after a short delay so the model picker is ready.
  setTimeout(() => provider.notifyModelsChanged(), 2000);

  // Management command — opened when user clicks the gear icon next to the provider
  const configureCmd = vscode.commands.registerCommand('custom-llm.configure', async () => {
    const cfg = vscode.workspace.getConfiguration('customLlm');

    const baseUrl = await vscode.window.showInputBox({
      title: 'Custom LLM — Base URL',
      value: cfg.get('baseUrl') ?? 'https://coding-intl.dashscope.aliyuncs.com/v1',
      prompt: 'Base URL of the OpenAI-compatible endpoint',
    });
    if (baseUrl === undefined) { return; }

    await cfg.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);

    const apiKey = await vscode.window.showInputBox({
      title: 'Custom LLM — API Key',
      value: cfg.get('apiKey') ?? '',
      prompt: 'API key (sk-…). Leave empty if the endpoint does not require authentication.',
      password: true,
    });
    if (apiKey === undefined) { return; }

    await cfg.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);

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

  // Chat participant @qwen
  registerChatParticipant(context);

  context.subscriptions.push(registration, configureCmd, cfgWatcher, provider);
}

export function deactivate() {
  // VS Code disposes subscriptions automatically
}
