import * as vscode from 'vscode';
import { CustomLlmProvider } from './provider';
import { registerChatParticipant } from './participant';

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
}

export interface ModelConfig {
  id: string;
  name: string;
  providerUrl: string;
  maxInputTokens: number;
  maxOutputTokens: number;
}

// ── Fallback defaults ──────────────────────────────────────────────────────────

const DEFAULT_PROVIDER: ProviderConfig = {
  name: 'Alibaba DashScope',
  baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
  apiKey: '',
};

const DEFAULT_MODELS: Omit<ModelConfig, 'providerUrl'>[] = [
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

// Known token limits per model ID prefix
const KNOWN_LIMITS: Array<[string, { maxInputTokens: number; maxOutputTokens: number }]> = [
  ['qwen3.6-plus',  { maxInputTokens: 1000000, maxOutputTokens: 65536  }],
  ['qwen3.5-plus',  { maxInputTokens: 1000000, maxOutputTokens: 16384  }],
  ['qwen3-max',     { maxInputTokens: 131072,  maxOutputTokens: 8192   }],
  ['qwen3-coder',   { maxInputTokens: 131072,  maxOutputTokens: 8192   }],
  ['kimi-k2',       { maxInputTokens: 262144,  maxOutputTokens: 32768  }],
  ['glm-5',         { maxInputTokens: 204800,  maxOutputTokens: 16384  }],
  ['glm-4',         { maxInputTokens: 131072,  maxOutputTokens: 8192   }],
  ['MiniMax',       { maxInputTokens: 262144,  maxOutputTokens: 8192   }],
];

function getKnownLimits(id: string) {
  for (const [prefix, limits] of KNOWN_LIMITS) {
    if (id.startsWith(prefix)) { return limits; }
  }
  return { maxInputTokens: 131072, maxOutputTokens: 8192 };
}

function toDisplayName(id: string): string {
  return id.split(/[-_.]/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

// ── Settings helpers ───────────────────────────────────────────────────────────

function getProviders(): ProviderConfig[] {
  return vscode.workspace.getConfiguration('customLlm').get<ProviderConfig[]>('providers') ?? [];
}

async function saveProviders(providers: ProviderConfig[]): Promise<void> {
  await vscode.workspace.getConfiguration('customLlm').update('providers', providers, vscode.ConfigurationTarget.Global);
}

function getModels(): ModelConfig[] {
  return vscode.workspace.getConfiguration('customLlm').get<ModelConfig[]>('models') ?? [];
}

async function saveModels(models: ModelConfig[]): Promise<void> {
  await vscode.workspace.getConfiguration('customLlm').update('models', models, vscode.ConfigurationTarget.Global);
}

// ── Migration from legacy single-provider settings ─────────────────────────────

async function migrateLegacySettings(): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('customLlm');
  const legacyUrl: string = cfg.get('baseUrl') ?? '';
  const legacyKey: string = cfg.get('apiKey') ?? '';

  // Already migrated or nothing to migrate
  if (!legacyUrl && !legacyKey) { return false; }
  const providers = getProviders();
  if (providers.length > 0) {
    // Already have providers — just clear old keys
    await cfg.update('baseUrl', undefined, vscode.ConfigurationTarget.Global);
    await cfg.update('apiKey',  undefined, vscode.ConfigurationTarget.Global);
    return false;
  }

  // Migrate: create first provider from legacy settings
  const provider: ProviderConfig = {
    name: legacyUrl.includes('dashscope') ? 'Alibaba DashScope' : 'Custom Provider',
    baseUrl: legacyUrl || DEFAULT_PROVIDER.baseUrl,
    apiKey: legacyKey,
  };
  await saveProviders([provider]);
  await cfg.update('baseUrl', undefined, vscode.ConfigurationTarget.Global);
  await cfg.update('apiKey',  undefined, vscode.ConfigurationTarget.Global);
  return true;
}

// ── Model discovery ────────────────────────────────────────────────────────────

async function fetchModelsForProvider(provider: ProviderConfig): Promise<ModelConfig[] | null> {
  if (!provider.apiKey) { return null; }

  try {
    const url = `${provider.baseUrl.replace(/\/$/, '')}/models`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { return null; }

    const json = await res.json() as {
      data?: Array<{ id: string; context_length?: number; max_completion_tokens?: number }>;
    };
    if (!Array.isArray(json?.data) || json.data.length === 0) { return null; }

    return json.data.map(m => {
      const known = getKnownLimits(m.id);
      return {
        id: m.id,
        name: toDisplayName(m.id),
        providerUrl: provider.baseUrl,
        maxInputTokens:  m.context_length       ?? known.maxInputTokens,
        maxOutputTokens: m.max_completion_tokens ?? known.maxOutputTokens,
      };
    });
  } catch {
    return null;
  }
}

async function discoverAllModels(silent = false): Promise<void> {
  const providers = getProviders();

  if (providers.length === 0) {
    // No providers configured — keep existing models or load defaults
    if (getModels().length === 0) {
      await saveModels(DEFAULT_MODELS.map(m => ({ ...m, providerUrl: DEFAULT_PROVIDER.baseUrl })));
    }
    return;
  }

  // Fetch models from every provider concurrently
  const results = await Promise.all(providers.map(p => fetchModelsForProvider(p)));

  // Merge: existing user models stay, newly discovered are added/updated
  const existing = getModels();
  const merged = new Map<string, ModelConfig>(existing.map(m => [m.id, m]));

  let discovered = 0;
  for (let i = 0; i < providers.length; i++) {
    const providerModels = results[i];
    if (!providerModels) { continue; }
    for (const m of providerModels) {
      merged.set(m.id, m);
      discovered++;
    }
  }

  await saveModels([...merged.values()]);

  if (!silent && discovered > 0) {
    const names = providers.map(p => p.name).join(', ');
    vscode.window.showInformationMessage(
      `Custom LLM: ${discovered} models loaded from ${names}`
    );
  }
}

// ── Copilot picker sync ────────────────────────────────────────────────────────

async function syncCopilotPickerModels(): Promise<void> {
  const models = getModels();
  const providers = getProviders();

  // Build a map: providerUrl → apiKey for fast lookup
  const keyMap = new Map(providers.map(p => [p.baseUrl, p.apiKey]));

  const customOAIModels: Record<string, object> = {};
  for (const model of models) {
    const apiKey = keyMap.get(model.providerUrl) ?? '';
    customOAIModels[model.id] = {
      name: model.name,
      url: model.providerUrl,
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
  } catch { /* older VS Code */ }
}

// ── Commands ───────────────────────────────────────────────────────────────────

async function promptForApiKey(providerName: string, currentValue = ''): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `Custom LLM — API Key for "${providerName}"`,
    prompt: 'Paste your API key (e.g. sk-…). Required for most providers — without it, model discovery and requests will fail.',
    placeHolder: 'sk-...',
    password: true,
    value: currentValue,
    ignoreFocusOut: true, // critical: keeps the box open when VS Code's native UI closes after the previous step
  });
}

async function cmdAddProvider(provider?: CustomLlmProvider): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'Custom LLM — Provider name',
    prompt: 'e.g. "Alibaba DashScope" or "OpenRouter"',
    placeHolder: 'My Provider',
    ignoreFocusOut: true,
  });
  if (!name) { return; }

  const baseUrl = await vscode.window.showInputBox({
    title: 'Custom LLM — Base URL',
    prompt: 'OpenAI-compatible endpoint URL (must end with /v1)',
    placeHolder: 'https://coding-intl.dashscope.aliyuncs.com/v1',
    ignoreFocusOut: true,
  });
  if (!baseUrl) { return; }

  const apiKey = await promptForApiKey(name);
  if (apiKey === undefined) { return; }

  const providers = getProviders();
  // Replace if same URL already exists
  const idx = providers.findIndex(p => p.baseUrl === baseUrl);
  if (idx >= 0) {
    providers[idx] = { name, baseUrl, apiKey };
  } else {
    providers.push({ name, baseUrl, apiKey });
  }
  await saveProviders(providers);

  // Safety net — if the API key prompt was skipped / dismissed by a VS Code
  // UI transition (known with the gear-icon management flow in 1.104+),
  // offer a second chance via notification action.
  if (!apiKey) {
    vscode.window.showWarningMessage(
      `Custom LLM: Provider "${name}" saved without an API key.`,
      'Add API key now'
    ).then(async choice => {
      if (choice !== 'Add API key now') { return; }
      const key = await promptForApiKey(name);
      if (!key) { return; }
      const current = getProviders();
      const i = current.findIndex(p => p.baseUrl === baseUrl);
      if (i >= 0) {
        current[i].apiKey = key;
        await saveProviders(current);
        await discoverAllModels(false);
        await syncCopilotPickerModels();
        provider?.notifyModelsChanged();
      }
    });
  } else {
    vscode.window.showInformationMessage(`Custom LLM: Provider "${name}" saved. Fetching models…`);
  }

  await discoverAllModels(false);
  await syncCopilotPickerModels();
  provider?.notifyModelsChanged();
}

async function cmdManageProviders(provider: CustomLlmProvider): Promise<void> {
  const providers = getProviders();
  if (providers.length === 0) {
    const add = await vscode.window.showInformationMessage(
      'No providers configured yet.', 'Add provider'
    );
    if (add) { await cmdAddProvider(); }
    return;
  }

  const items = [
    ...providers.map((p, i) => ({
      label: p.name,
      description: p.baseUrl,
      detail: p.apiKey ? '🔑 API key set' : '⚠️ No API key',
      index: i,
    })),
    { label: '$(add) Add new provider', description: '', detail: '', index: -1 },
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Custom LLM — Manage providers',
    placeHolder: 'Select a provider to edit or remove',
  });
  if (!pick) { return; }

  if (pick.index === -1) {
    await cmdAddProvider();
    return;
  }

  const action = await vscode.window.showQuickPick(
    ['Edit', 'Remove'],
    { title: `Provider: ${pick.label}` }
  );
  if (!action) { return; }

  if (action === 'Remove') {
    providers.splice(pick.index, 1);
    await saveProviders(providers);
    // Remove models that belonged to this provider
    const removed = pick.description ?? '';
    const remaining = getModels().filter(m => m.providerUrl !== removed);
    await saveModels(remaining);
    vscode.window.showInformationMessage(`Custom LLM: Provider "${pick.label}" removed.`);
  } else {
    // Edit — re-use add flow pre-filled
    const p = providers[pick.index];
    const apiKey = await vscode.window.showInputBox({
      title: `Edit "${p.name}" — API Key`,
      value: p.apiKey,
      password: true,
    });
    if (apiKey === undefined) { return; }
    providers[pick.index].apiKey = apiKey;
    await saveProviders(providers);
    vscode.window.showInformationMessage(`Custom LLM: "${p.name}" updated. Refreshing models…`);
    await discoverAllModels(true);
  }

  await syncCopilotPickerModels();
  provider.notifyModelsChanged();
}

// ── Activate ───────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  const provider = new CustomLlmProvider();
  const registration = vscode.lm.registerLanguageModelChatProvider('custom-llm', provider);

  // Startup sequence: migrate legacy → discover → sync picker
  (async () => {
    await migrateLegacySettings();
    await discoverAllModels(true);
    await syncCopilotPickerModels();
    setTimeout(() => provider.notifyModelsChanged(), 2000);
  })();

  const addProviderCmd = vscode.commands.registerCommand(
    'custom-llm.addProvider', () => cmdAddProvider(provider)
  );

  const manageProvidersCmd = vscode.commands.registerCommand(
    'custom-llm.manageProviders', () => cmdManageProviders(provider)
  );

  const refreshCmd = vscode.commands.registerCommand('custom-llm.refreshModels', async () => {
    vscode.window.showInformationMessage('Custom LLM: Fetching models from all providers…');
    await discoverAllModels(false);
    await syncCopilotPickerModels();
    provider.notifyModelsChanged();
  });

  const cfgWatcher = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('customLlm.providers')) {
      // Providers list changed (e.g. edited directly in settings.json) —
      // re-discover models from all providers, then notify.
      discoverAllModels(true).then(async () => {
        await syncCopilotPickerModels();
        provider.notifyModelsChanged();
      });
    } else if (e.affectsConfiguration('customLlm')) {
      // Other customLlm settings changed (e.g. models list updated by discovery) —
      // just re-sync the picker without triggering another discovery loop.
      syncCopilotPickerModels();
      provider.notifyModelsChanged();
    }
  });

  registerChatParticipant(context);
  context.subscriptions.push(registration, addProviderCmd, manageProvidersCmd, refreshCmd, cfgWatcher, provider);
}

export function deactivate() {}
