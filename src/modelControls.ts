import { ModelConfig, ThinkingEffort, getModelProfile } from './modelRegistry';

const EFFORTS: readonly ThinkingEffort[] = [
  'auto', 'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];

export interface ReasoningRequestOptions {
  readonly modelOptions?: Readonly<Record<string, unknown>>;
  /** VS Code 1.122's optional chatProvider configuration channel. */
  readonly modelConfiguration?: Readonly<Record<string, unknown>>;
}

export function resolveThinkingEffort(
  model: Pick<ModelConfig, 'thinkingEffort'> | undefined,
  globalEffort: unknown,
  options: ReasoningRequestOptions = {},
): { effort: ThinkingEffort; source: string } {
  const candidates: Array<[unknown, string]> = [
    [options.modelOptions?.reasoningEffort ?? options.modelOptions?.reasoning_effort, 'request'],
    [options.modelConfiguration?.reasoningEffort, 'model picker'],
    [model?.thinkingEffort, 'model setting'],
    [globalEffort, 'global setting'],
  ];
  for (const [value, source] of candidates) {
    if (typeof value === 'string' && EFFORTS.includes(value as ThinkingEffort)) {
      return { effort: value as ThinkingEffort, source };
    }
  }
  return { effort: 'auto', source: 'provider default' };
}

export function reasoningChoices(modelId: string, inheritedLabel: string) {
  return [
    { label: inheritedLabel, value: 'inherit' as const },
    ...getModelProfile(modelId).supportedEfforts.map(value => ({
      label: value === 'auto' ? 'Provider default (auto)'
        : value === 'none' ? 'Off (no thinking)'
          : value.charAt(0).toUpperCase() + value.slice(1),
      value,
    })),
  ];
}

export function supportsNativeReasoningPicker(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major > 1 || (major === 1 && minor >= 122);
}

/**
 * Optional runtime integration, not a dependency on enabledApiProposals.
 * VS Code 1.122 forwards configurationSchema/modelConfiguration; older hosts
 * retain the stable Command Palette/settings controls.
 * See vscode.proposed.chatProvider.d.ts and extHostLanguageModels.ts at 1.122.0.
 */
export function reasoningConfigurationSchema(model: ModelConfig, globalEffort: unknown) {
  if (getModelProfile(model.id).reasoning === 'none') { return undefined; }
  const inherited = resolveThinkingEffort(model, globalEffort).effort;
  const choices = reasoningChoices(model.id, `Use extension setting (${inherited})`);
  return {
    properties: {
      reasoningEffort: {
        type: 'string',
        title: 'Reasoning effort',
        description: 'Reasoning depth for this model. Provider default sends no reasoning override.',
        enum: choices.map(choice => choice.value),
        enumItemLabels: choices.map(choice => choice.label),
        default: 'inherit',
        group: 'navigation',
      },
    },
  };
}

export function resolveModelLimits(model: Pick<ModelConfig,
  'id' | 'maxInputTokens' | 'maxOutputTokens' | 'contextWindow'>) {
  const maxOutputTokens = Number.isSafeInteger(model.maxOutputTokens) && model.maxOutputTokens > 0
    ? model.maxOutputTokens : 8192;
  if (model.contextWindow !== undefined) {
    if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= maxOutputTokens) {
      throw new Error(
        `Custom LLM: contextWindow for "${model.id}" must be a whole number greater than ` +
        `maxOutputTokens (${maxOutputTokens}).`
      );
    }
    return {
      maxInputTokens: model.contextWindow - maxOutputTokens,
      maxOutputTokens,
      contextWindow: model.contextWindow,
    };
  }
  const maxInputTokens = Number.isSafeInteger(model.maxInputTokens) && model.maxInputTokens > 0
    ? model.maxInputTokens : 131072;
  return { maxInputTokens, maxOutputTokens, contextWindow: maxInputTokens + maxOutputTokens };
}
