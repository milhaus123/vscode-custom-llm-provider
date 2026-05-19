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
    // Already have providers -- just clear old keys
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

  const baseUrl = provider.baseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${provider.apiKey}`,
  };

  try {
    // 1. Try /model/info first (LiteLLM endpoint -- richer metadata)
    const infoUrl = `${baseUrl}/model/info`;
    const infoRes = await fetch(infoUrl, {
      headers,
      signal: AbortSignal.timeout(8000),
    });

    if (infoRes.ok) {
      const infoJson = await infoRes.json() as {
        data?: Array<{
          model_name?: string;
          model_info?: {
            max_tokens?: number;
            max_input_tokens?: number;
            supports_tool_choice?: boolean;
            supports_function_calling?: boolean;
          };
        }>;
      };

      if (Array.isArray(infoJson?.data) && infoJson.data.length > 0) {
        return infoJson.data
          .filter(m => !!m.model_name)
          .map(m => {
            const id = m.model_name!;
            const known = getKnownLimits(id);
            const info = m.model_info ?? {};
            return {
              id,
              name: toDisplayName(id),
              providerUrl: provider.baseUrl,
              maxInputTokens:  info.max_input_tokens ?? known.maxInputTokens,
              maxOutputTokens: info.max_tokens       ?? known.maxOutputTokens,
            };
          });
      }
    }

    // 2. Fallback to /models (standard OpenAI endpoint)
    const modelsUrl = `${baseUrl}/models`;
    const res = await fetch(modelsUrl, {
      headers,
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
    // No providers configured -- keep existing models or load defaults
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

// ── Copilot BYOK cleanup ───────────────────────────────────────────────────────

async function cleanupLegacyByokEntries(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('github.copilot.chat');
  const existing = cfg.get<Record<string, object>>('customOAIModels');
  if (!existing || Object.keys(existing).length === 0) { return; }

  const ourModelIds = new Set(getModels().map(m => m.id));
  const cleaned: Record<string, object> = {};
  let removed = 0;

  for (const [id, val] of Object.entries(existing)) {
    if (ourModelIds.has(id)) {
      removed++;
      continue;
    }
    cleaned[id] = val;
  }

  if (removed === 0) { return; }

  try {
    await cfg.update('customOAIModels', cleaned, vscode.ConfigurationTarget.Global);
  } catch { /* older VS Code or no permission */ }
}

// ── Commands ───────────────────────────────────────────────────────────────────

async function promptForApiKey(providerName: string, currentValue = ''): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `Custom LLM -- API Key for "${providerName}"`,
    prompt: 'Paste your API key (e.g. sk-...). Required for most providers.',
    placeHolder: 'sk-...',
    password: true,
    value: currentValue,
    ignoreFocusOut: true,
  });
}

async function cmdAddProvider(provider?: CustomLlmProvider): Promise<void> {
  // VS Code 1.104+ -- when this command is invoked as a managementCommand
  // from the Copilot model-picker panel, the webview keeps focus and immediately
  // dismisses any showInputBox that opens synchronously. A short settle-time
  // lets VS Code close the picker panel before we show our native dialogs.
  await new Promise<void>(resolve => setTimeout(resolve, 200));

  const name = await vscode.window.showInputBox({
    title: 'Custom LLM -- Provider name',
    prompt: 'e.g. "Alibaba DashScope" or "OpenRouter"',
    placeHolder: 'My Provider',
    ignoreFocusOut: true,
  });
  if (!name) { return; }

  const baseUrl = await vscode.window.showInputBox({
    title: 'Custom LLM -- Base URL',
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

  // Safety net -- if the API key prompt was dismissed by a VS Code UI transition,
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
        await cleanupLegacyByokEntries();
        provider?.notifyModelsChanged();
      }
    });
  } else {
    vscode.window.showInformationMessage(`Custom LLM: Provider "${name}" saved. Fetching models...`);
  }

  await discoverAllModels(false);
  await cleanupLegacyByokEntries();
  provider?.notifyModelsChanged();
}

async function cmdManageProviders(provider: CustomLlmProvider): Promise<void> {
  // VS Code 1.104+ -- when invoked as managementCommand from the Copilot
  // model-picker (both gear icon and "Add Models" flows) the webview keeps
  // focus and can dismiss native dialogs opened synchronously. A short
  // settle-time lets VS Code close the picker before we show our UI.
  await new Promise<void>(resolve => setTimeout(resolve, 200));

  const providers = getProviders();
  if (providers.length === 0) {
    // Skip the info-message toast; jump straight to the add wizard so the
    // QuickPick / InputBox flow works correctly from the picker context.
    await cmdAddProvider(provider);
    return;
  }

  const items = [
    ...providers.map((p, i) => ({
      label: p.name,
      description: p.baseUrl,
      detail: p.apiKey ? 'API key set' : 'No API key',
      index: i,
    })),
    { label: '$(add) Add new provider', description: '', detail: '', index: -1 },
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Custom LLM -- Manage providers',
    placeHolder: 'Select a provider to edit, or add a new one',
  });
  if (!pick) { return; }

  if (pick.index === -1) {
    await cmdAddProvider(provider);
    return;
  }

  const action = await vscode.window.showQuickPick(
    ['Edit name', 'Edit endpoint URL', 'Edit API key', 'Remove'],
    { title: `Provider: ${pick.label}` }
  );
  if (!action) { return; }

  if (action === 'Remove') {
    providers.splice(pick.index, 1);
    await saveProviders(providers);
    const removedUrl = pick.description ?? '';
    const remaining = getModels().filter(m => m.providerUrl !== removedUrl);
    await saveModels(remaining);
    vscode.window.showInformationMessage(`Custom LLM: Provider "${pick.label}" removed.`);

  } else if (action === 'Edit name') {
    const p = providers[pick.index];
    const newName = await vscode.window.showInputBox({
      title: 'Edit provider name',
      value: p.name,
      ignoreFocusOut: true,
    });
    if (newName === undefined) { return; }
    providers[pick.index].name = newName;
    await saveProviders(providers);
    vscode.window.showInformationMessage(`Custom LLM: Provider renamed to "${newName}".`);

  } else if (action === 'Edit endpoint URL') {
    const p = providers[pick.index];
    const newUrl = await vscode.window.showInputBox({
      title: `Edit endpoint URL for "${p.name}"`,
      prompt: 'OpenAI-compatible endpoint URL (must end with /v1)',
      value: p.baseUrl,
      placeHolder: 'https://coding-intl.dashscope.aliyuncs.com/v1',
      ignoreFocusOut: true,
    });
    if (newUrl === undefined) { return; }
    const oldUrl = providers[pick.index].baseUrl;
    providers[pick.index].baseUrl = newUrl;
    await saveProviders(providers);
    // Re-tag all models that pointed to the old URL
    const updatedModels = getModels().map(m => (m.providerUrl === oldUrl ? { ...m, providerUrl: newUrl } : m));
    await saveModels(updatedModels);
    vscode.window.showInformationMessage(`Custom LLM: "${p.name}" endpoint updated. Refreshing models...`);
    await discoverAllModels(true);

  } else {
    // Edit API key
    const p = providers[pick.index];
    const apiKey = await promptForApiKey(p.name, p.apiKey);
    if (apiKey === undefined) { return; }
    providers[pick.index].apiKey = apiKey;
    await saveProviders(providers);
    vscode.window.showInformationMessage(`Custom LLM: "${p.name}" API key updated. Refreshing models...`);
    await discoverAllModels(true);
  }

  await cleanupLegacyByokEntries();
  provider.notifyModelsChanged();
}

async function cmdTestConnection(): Promise<void> {
  const providers = getProviders();
  if (providers.length === 0) {
    vscode.window.showWarningMessage(
      'Custom LLM: No providers configured yet.',
      'Add provider'
    ).then(c => { if (c) { vscode.commands.executeCommand('custom-llm.addProvider'); } });
    return;
  }

  // If multiple providers, let user pick one; otherwise test the only one
  let selected: ProviderConfig;
  if (providers.length === 1) {
    selected = providers[0];
  } else {
    const pick = await vscode.window.showQuickPick(
      providers.map((p, i) => ({
        label: p.name,
        description: p.baseUrl,
        detail: p.apiKey ? 'API key set' : 'No API key',
        index: i,
      })),
      { title: 'Custom LLM -- Test connection', placeHolder: 'Select provider to test' }
    );
    if (!pick) { return; }
    selected = providers[pick.index];
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Custom LLM: Testing "${selected.name}"...`, cancellable: false },
    async () => {
      const baseUrl = selected.baseUrl.replace(/\/$/, '');
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(selected.apiKey ? { 'Authorization': `Bearer ${selected.apiKey}` } : {}),
      };
      const t0 = Date.now();

      // Step 1 -- model list (try /model/info first, then /models)
      let modelCount = 0;
      let endpointUsed = '';
      try {
        const infoRes = await fetch(`${baseUrl}/model/info`, { headers, signal: AbortSignal.timeout(8000) });
        if (infoRes.ok) {
          const j = await infoRes.json() as { data?: unknown[] };
          modelCount = j?.data?.length ?? 0;
          endpointUsed = '/model/info';
        } else {
          const modelsRes = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(8000) });
          if (modelsRes.ok) {
            const j = await modelsRes.json() as { data?: unknown[] };
            modelCount = j?.data?.length ?? 0;
            endpointUsed = '/models';
          }
        }
      } catch (e) {
        vscode.window.showErrorMessage(
          `Custom LLM "${selected.name}" -- unreachable: ${e instanceof Error ? e.message : String(e)}`
        );
        return;
      }

      // Step 2 -- quick ping (tiny chat request to verify the model responds)
      let pingMs = -1;
      const models = getModels().filter(m => m.providerUrl === selected.baseUrl);
      if (models.length > 0) {
        const pingModel = models[0];
        const t1 = Date.now();
        try {
          const pingRes = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: pingModel.id,
              messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
              max_tokens: 8,
              stream: false,
            }),
            signal: AbortSignal.timeout(15000),
          });
          if (pingRes.ok) { pingMs = Date.now() - t1; }
        } catch { /* ping is best-effort */ }
      }

      const listMs = Date.now() - t0 - (pingMs > 0 ? pingMs : 0);
      const pingInfo = pingMs >= 0 ? ` / ping ${pingMs}ms` : '';

      if (modelCount > 0) {
        vscode.window.showInformationMessage(
          `Custom LLM "${selected.name}" -- ${modelCount} models via ${endpointUsed} (${listMs}ms)${pingInfo}`
        );
      } else {
        vscode.window.showWarningMessage(
          `Custom LLM "${selected.name}" -- server reachable but returned 0 models. Check base URL and API key.`
        );
      }
    }
  );
}

// ── Activate ───────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '$(check) Custom LLM';
  statusBar.tooltip = 'Custom LLM Provider';
  statusBar.command = 'custom-llm.manageProviders';
  statusBar.show();
  const provider = new CustomLlmProvider(statusBar);
  const registration = vscode.lm.registerLanguageModelChatProvider('custom-llm', provider);

  // Startup sequence: migrate legacy settings, discover models, clean up stale
  // BYOK entries left by versions <= 0.4.6.
  (async () => {
    await migrateLegacySettings();
    await discoverAllModels(true);
    await cleanupLegacyByokEntries();
    setTimeout(() => provider.notifyModelsChanged(), 2000);
  })();

  const addProviderCmd = vscode.commands.registerCommand(
    'custom-llm.addProvider', () => cmdAddProvider(provider)
  );

  const manageProvidersCmd = vscode.commands.registerCommand(
    'custom-llm.manageProviders', () => cmdManageProviders(provider)
  );

  const refreshCmd = vscode.commands.registerCommand('custom-llm.refreshModels', async () => {
    vscode.window.showInformationMessage('Custom LLM: Fetching models from all providers...');
    await discoverAllModels(false);
    await cleanupLegacyByokEntries();
    provider.notifyModelsChanged();
  });

  const testConnectionCmd = vscode.commands.registerCommand(
    'custom-llm.testConnection', () => cmdTestConnection()
  );

  const cfgWatcher = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('customLlm.providers')) {
      discoverAllModels(true).then(() => {
        provider.notifyModelsChanged();
      });
    } else if (e.affectsConfiguration('customLlm.models')) {
      provider.notifyModelsChanged();
    }
  });

  registerChatParticipant(context);
  context.subscriptions.push(registration, addProviderCmd, manageProvidersCmd, refreshCmd, testConnectionCmd, cfgWatcher, provider);
}

export function deactivate() {}
