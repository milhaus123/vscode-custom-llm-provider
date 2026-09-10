export type ThinkingEffort =
  | 'auto'
  | 'off'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export interface ModelConfig {
  /** Model identifier sent unchanged to the upstream provider. */
  id: string;
  name: string;
  providerId: string;
  /** @deprecated Pre-0.5 fallback used only during migration. */
  providerUrl?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Optional total budget (input + output); takes precedence over maxInputTokens. */
  contextWindow?: number;
  /** Explicit/discovered capability. Undefined means that the profile policy decides. */
  imageInput?: boolean;
  /** Explicit/discovered capability. Undefined means that the profile policy decides. */
  toolCalling?: boolean;
  hidden?: boolean;
  thinkingEffort?: ThinkingEffort;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  providerId: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  imageInput?: boolean;
  toolCalling?: boolean;
  hidden?: boolean;
}

export interface ModelProfile {
  imageInput?: boolean;
  toolCalling?: boolean;
  reasoning: 'qwen-budget' | 'glm-5.3' | 'reasoning-effort' | 'none';
  supportedEfforts: readonly ThinkingEffort[];
}

export interface ResolvedCapabilities {
  imageInput: boolean;
  toolCalling: boolean;
  imageSource: 'model' | 'profile' | 'safe-default';
  toolSource: 'model' | 'profile' | 'safe-default';
}

export interface ThinkingParamsResult {
  params: Record<string, unknown>;
  effectiveEffort?: string;
  warning?: string;
}

const DEFAULT_LIMITS = { maxInputTokens: 131072, maxOutputTokens: 8192 };

const KNOWN_LIMITS: Array<[string, { maxInputTokens: number; maxOutputTokens: number }]> = [
  ['qwen3.6-plus', { maxInputTokens: 1000000, maxOutputTokens: 65536 }],
  ['qwen3.5-plus', { maxInputTokens: 1000000, maxOutputTokens: 16384 }],
  ['qwen3-max', { maxInputTokens: 131072, maxOutputTokens: 8192 }],
  ['qwen3-coder', { maxInputTokens: 131072, maxOutputTokens: 8192 }],
  ['kimi-k2', { maxInputTokens: 262144, maxOutputTokens: 32768 }],
  ['glm-5', { maxInputTokens: 204800, maxOutputTokens: 16384 }],
  ['glm-4', { maxInputTokens: 131072, maxOutputTokens: 8192 }],
  ['minimax', { maxInputTokens: 262144, maxOutputTokens: 8192 }],
];

/** Last path component used for family matching; the full ID still goes upstream. */
export function normalizeModelId(id: string): string {
  return (id.split('/').pop() ?? id).trim().toLowerCase();
}

/** VS Code requires IDs to be unique across every logical provider we expose. */
export function modelRegistrationId(providerId: string, upstreamModelId: string): string {
  return `${providerId}::${upstreamModelId}`;
}

export function getKnownLimits(id: string): { maxInputTokens: number; maxOutputTokens: number } {
  const normalized = normalizeModelId(id);
  for (const [prefix, limits] of KNOWN_LIMITS) {
    if (normalized.startsWith(prefix)) {
      return limits;
    }
  }
  return DEFAULT_LIMITS;
}

export function getModelProfile(modelId: string): ModelProfile {
  const id = normalizeModelId(modelId);

  const isGlm53 = id.startsWith('glm-5.3');
  const isTextGlm53 = /^glm-5\.3(?:$|-\d{4})/.test(id);
  const isQwen = id.startsWith('qwen');
  const isVisionNamed = /(^|[-_.])(vl|vision)([-_.]|$)/.test(id) || id.includes('omni');
  const isKnownToolModel =
    isQwen ||
    id.startsWith('glm-') ||
    id.startsWith('kimi-k2') ||
    id.startsWith('minimax-m2') ||
    /^(o1|o3|o4|gpt-5|gpt-4|deepseek-|claude-|gemini-|mistral-|codestral-)/.test(id);

  if (isGlm53) {
    return {
      ...(isTextGlm53 ? { imageInput: false } : {}),
      toolCalling: true,
      reasoning: 'glm-5.3',
      supportedEfforts: ['auto', 'low', 'high', 'max'],
    };
  }

  if (isQwen) {
    return {
      imageInput: isVisionNamed,
      toolCalling: true,
      reasoning: 'qwen-budget',
      supportedEfforts: ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'max'],
    };
  }

  const usesReasoningEffort =
    /^(o1|o3|o4|gpt-5|deepseek-v4|deepseek-chat)/.test(id) || id.includes('reasoning');
  if (usesReasoningEffort) {
    return {
      toolCalling: true,
      reasoning: 'reasoning-effort',
      supportedEfforts: ['auto', 'low', 'medium', 'high'],
    };
  }

  return {
    ...(isVisionNamed ? { imageInput: true } : {}),
    ...(isKnownToolModel ? { toolCalling: true } : {}),
    reasoning: 'none',
    supportedEfforts: ['auto'],
  };
}

/** Unknown capabilities fail closed; users can enable them from Manage models. */
export function resolveCapabilities(model: Pick<ModelConfig, 'id' | 'imageInput' | 'toolCalling'>): ResolvedCapabilities {
  const profile = getModelProfile(model.id);
  return {
    imageInput: model.imageInput ?? profile.imageInput ?? false,
    toolCalling: model.toolCalling ?? profile.toolCalling ?? false,
    imageSource: model.imageInput !== undefined
      ? 'model'
      : profile.imageInput !== undefined ? 'profile' : 'safe-default',
    toolSource: model.toolCalling !== undefined
      ? 'model'
      : profile.toolCalling !== undefined ? 'profile' : 'safe-default',
  };
}

/**
 * Merge discovery results without losing user-edited fields. Entries are keyed
 * by provider + upstream model ID, so equal IDs from two endpoints can coexist.
 */
export function mergeDiscoveredModels(
  existing: readonly ModelConfig[],
  discoveredModels: readonly DiscoveredModel[],
): ModelConfig[] {
  const merged = new Map<string, ModelConfig>();
  for (const model of existing) {
    merged.set(modelRegistrationId(model.providerId, model.id), { ...model });
  }

  for (const model of discoveredModels) {
    const key = modelRegistrationId(model.providerId, model.id);
    const previous = merged.get(key);
    const known = getKnownLimits(model.id);
    merged.set(key, {
      ...previous,
      id: model.id,
      name: previous?.name ?? model.name,
      providerId: model.providerId,
      maxInputTokens: previous?.maxInputTokens ?? model.maxInputTokens ?? known.maxInputTokens,
      maxOutputTokens: previous?.maxOutputTokens ?? model.maxOutputTokens ?? known.maxOutputTokens,
      imageInput: previous?.imageInput ?? model.imageInput,
      toolCalling: previous?.toolCalling ?? model.toolCalling,
      hidden: previous?.hidden ?? model.hidden,
      // thinkingEffort and future user fields survive through ...previous.
    });
  }

  return [...merged.values()];
}

export function findModelByRegistrationId(
  models: readonly ModelConfig[],
  registrationId: string,
): ModelConfig | undefined {
  const exact = models.find(m => modelRegistrationId(m.providerId, m.id) === registrationId);
  if (exact) {
    return exact;
  }

  // Compatibility for chats pinned before provider-qualified IDs were added.
  const legacy = models.filter(m => m.id === registrationId);
  return legacy.length === 1 ? legacy[0] : undefined;
}

export function buildThinkingParams(
  modelId: string,
  effortValue: string,
  maxOutputTokens: number,
): ThinkingParamsResult {
  const effort = (effortValue === 'off' ? 'none' : effortValue) as ThinkingEffort;
  if (effort === 'auto') {
    return { params: {} };
  }

  const profile = getModelProfile(modelId);

  if (profile.reasoning === 'glm-5.3') {
    if (effort === 'none') {
      return {
        params: { thinking: { type: 'enabled' }, reasoning_effort: 'low' },
        effectiveEffort: 'low',
        warning: `GLM-5.3 cannot disable thinking; using reasoning_effort=low instead.`,
      };
    }
    const mapped = effort === 'minimal' || effort === 'low'
      ? 'low'
      : effort === 'medium' || effort === 'high' ? 'high' : 'max';
    return {
      params: { thinking: { type: 'enabled' }, reasoning_effort: mapped },
      effectiveEffort: mapped,
    };
  }

  if (profile.reasoning === 'qwen-budget') {
    if (effort === 'none') {
      return { params: { enable_thinking: false }, effectiveEffort: 'none' };
    }
    const requested: Record<string, number> = {
      minimal: 512,
      low: 1024,
      medium: 8192,
      high: 32768,
      xhigh: 65536,
      max: Math.max(maxOutputTokens - 1, 1),
    };
    const budget = Math.max(1, Math.min(requested[effort] ?? 8192, Math.max(maxOutputTokens - 1, 1)));
    return {
      params: { enable_thinking: true, thinking_budget: budget },
      effectiveEffort: effort,
    };
  }

  if (profile.reasoning === 'reasoning-effort') {
    const mapped = effort === 'none' || effort === 'minimal' ? 'low'
      : effort === 'xhigh' || effort === 'max' ? 'high' : effort;
    return { params: { reasoning_effort: mapped }, effectiveEffort: mapped };
  }

  return {
    params: {},
    warning: `Thinking effort "${effortValue}" is not supported for model "${modelId}" and was not sent.`,
  };
}
