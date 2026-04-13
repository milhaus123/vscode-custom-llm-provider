import * as vscode from 'vscode';
import { CustomLlmProvider } from './provider';
import { registerChatParticipant } from './participant';

interface ModelConfig {
  id: string;
  name: string;
  maxInputTokens: number;
  maxOutputTokens: number;
}

// Fallback model list used when dynamic discovery fails or no API key is set.
// Also used as a source for known token limits (providers don't return these via /v1/models).
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

// Known token limits per model ID prefix — used when /v1/models doesn't return context sizes.
const KNOWN_LIMITS: Record<string, { maxInputTokens: number; maxOutputTokens: number }> = {
  'qwen3.6-plus':         { maxInputTokens: 1000000, maxOutputTokens: 65536  },
  'qwen3.5-plus':         { maxInputTokens: 1000000, maxOutputTokens: 16384  },
  'qwen3-max':            { maxInputTokens: 131072,  maxOutputTokens: 8192   },
  'qwen3-coder':          { maxInputTokens: 131072,  maxOutputTokens: 8192   },
  'kimi-k2':              { maxInputTokens: 262144,  maxOutputTokens: 32768  },
  'glm-5':                { maxInputTokens: 204800,  maxOutputTokens: 16384  },
  'glm-4':                { maxInputTokens: 131072,  maxOutputTokens: 8192   },
  'MiniMax':              { maxInputTokens: 262144,  maxOutputTokens: 8192   },
};

const DEFAULT_LIMITS = { maxInputTokens: 131072, maxOutputTokens: 8192 };

/** Look up known token limits for a model by matching ID prefixes. */
function getKnownLimits(modelId: string) {
  for (const [prefix, limits] of Object.entries(KNOWN_LIMITS)) {
    if (modelId.startsWith(prefix)) { return limits; }
  }
  return DEFAULT_LIMITS;
}

/** Convert a raw model ID to a human-readable display name. */
function toDisplayName(id: string): string {
  // e.g. "qwen3-coder-plus" → "Qwen3 Coder Plus"
  return id
    .split(/[-_]/)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

/**
 * Fetch available models from the provider's /v1/models endpoint.
 * Returns null if the request fails (no key, network error, unsupported endpoint).
 */
async function fetchModelsFromApi(baseUrl: string, apiKey: string): Promise<ModelConfig[] | null> {
  if (!apiKey) { return null; }

  try {
    const url = `${baseUrl.replace(/\/$/, '')}/models`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) { return null; }

    const json = await response.json() as { data?: Array<{ id: string; context_length?: number; max_completion_tokens?: number }> };
    const data = json?.data;
    if (!Array.isArray(data) || data.length === 0) { return null; }

    return data.map(m => {
      const known = getKnownLimits(m.id);
      return {
        id: m.id,
        name: toDisplayName(m.id),
        // Some providers return context_length / max_completion_tokens — prefer those when available
        maxInputTokens:  m.context_length        ?? known.maxInputTokens,
        maxOutputTokens: m.max_completion_tokens  ?? known.maxOutputTokens,
      };
    });
  } catch {
    return null;
  }
}

/**
 * Discover models: try API first, fall back to DEFAULT_MODELS.
 * Saves the result to customLlm.models so the user can see and edit them.
 * Returns true if models were updated.
 */
async function discoverAndSaveModels(silent = false): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('customLlm');
  const baseUrl: string = cfg.get('baseUrl') ?? '';
  const apiKey: string  = cfg.get('apiKey')  ?? '';

  const discovered = await fetchModelsFromApi(baseUrl, apiKey);

  if (discovered) {
    await cfg.update('models', discovered, vscode.ConfigurationTarget.Global);
    if (!silent) {
      vscode.window.showInformationMessage(
        `Custom LLM: ${discovered.length} models loaded from ${baseUrl}`
      );
    }
    return true;
  }

  // API discovery failed — fall back: merge DEFAULT_MODELS into existing settings
  return await migrateModels();
}

/**
 * Merge DEFAULT_MODELS into existing user settings:
 * - Adds missing models, updates changed token limits.
 * - Preserves custom user-added models.
 */
async function migrateModels(): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('customLlm');
  const userModels: ModelConfig[] = cfg.get('models') ?? [];

  const defaultById = new Map(DEFAULT_MODELS.map(m => [m.id, m]));
  let changed = false;

  const updated = userModels.map(m => {
    const def = defaultById.get(m.id);
    if (!def) { return m; }
    if (m.maxInputTokens !== def.maxInputTokens || m.maxOutputTokens !== def.maxOutputTokens) {
      changed = true;
      return { ...m, maxInputTokens: def.maxInputTokens, maxOutputTokens: def.maxOutputTokens };
    }
    return m;
  });

  const existingIds = new Set(updated.map(m => m.id));
  const newModels = DEFAULT_MODELS.filter(m => !existingIds.has(m.id));
  if (newModels.length > 0) { changed = true; }

  if (!changed) { return false; }

  await cfg.update('models', [...updated, ...newModels], vscode.ConfigurationTarget.Global);
  return true;
}

/**
 * Sync customLlm.models into github.copilot.chat.customOAIModels
 * so models appear in the Copilot Chat model picker.
 */
async function syncCopilotPickerModels(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('customLlm');
  const baseUrl: string = cfg.get('baseUrl') ?? 'https://coding-intl.dashscope.aliyuncs.com/v1';
  const apiKey: string  = cfg.get('apiKey')  ?? '';
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

  const registration = vscode.lm.registerLanguageModelChatProvider('custom-llm', provider);

  // On activation: discover models from API, then sync picker.
  discoverAndSaveModels(true).then(() => {
    syncCopilotPickerModels();
  });

  setTimeout(() => provider.notifyModelsChanged(), 2000);

  // Configure command
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

    // After saving credentials, discover models from the new endpoint
    await discoverAndSaveModels(false);
    await syncCopilotPickerModels();
    provider.notifyModelsChanged();
  });

  // Refresh Models command — manually reload model list from API
  const refreshCmd = vscode.commands.registerCommand('custom-llm.refreshModels', async () => {
    vscode.window.showInformationMessage('Custom LLM: Fetching models from API…');
    await discoverAndSaveModels(false);
    await syncCopilotPickerModels();
    provider.notifyModelsChanged();
  });

  // Re-sync picker whenever settings change
  const cfgWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('customLlm')) {
      syncCopilotPickerModels();
      provider.notifyModelsChanged();
    }
  });

  registerChatParticipant(context);

  context.subscriptions.push(registration, configureCmd, refreshCmd, cfgWatcher, provider);
}

export function deactivate() {}
