import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reasoningConfigurationSchema, resolveModelLimits, resolveThinkingEffort,
} from '../src/modelControls';
import { mergeDiscoveredModels, type ModelConfig } from '../src/modelRegistry';

const glm: ModelConfig = {
  id: 'zai-org/GLM-5.3', name: 'GLM', providerId: 'example',
  maxInputTokens: 1000000, maxOutputTokens: 16384, thinkingEffort: 'low',
};

test('request, picker, model and global reasoning overrides have a defined priority', () => {
  assert.deepEqual(resolveThinkingEffort(glm, 'max', {
    modelOptions: { reasoning_effort: 'low' }, modelConfiguration: { reasoningEffort: 'high' },
  }), { effort: 'low', source: 'request' });
  assert.deepEqual(resolveThinkingEffort(glm, 'max', {
    modelConfiguration: { reasoningEffort: 'high' },
  }), { effort: 'high', source: 'model picker' });
  assert.deepEqual(resolveThinkingEffort(glm, 'max', {
    modelConfiguration: { reasoningEffort: 'inherit' },
  }), { effort: 'low', source: 'model setting' });
  assert.deepEqual(resolveThinkingEffort({}, 'max'), { effort: 'max', source: 'global setting' });
});

test('explicit auto uses the provider default instead of inheriting a higher effort', () => {
  assert.equal(resolveThinkingEffort({ thinkingEffort: 'auto' }, 'high').effort, 'auto');
  assert.equal(resolveThinkingEffort(glm, 'high', {
    modelConfiguration: { reasoningEffort: 'auto' },
  }).effort, 'auto');
  assert.equal(resolveThinkingEffort(glm, 'high', {
    modelOptions: { reasoningEffort: 'auto' }, modelConfiguration: { reasoningEffort: 'max' },
  }).effort, 'auto');
});

test('unknown request values are ignored instead of becoming maximum effort', () => {
  assert.equal(resolveThinkingEffort(glm, 'max', {
    modelOptions: { reasoningEffort: { invalid: true } }, modelConfiguration: { reasoningEffort: 'extreme' },
  }).effort, 'low');
});

test('GLM picker advertises only its supported levels and unknown models have no picker', () => {
  const schema = reasoningConfigurationSchema(glm, 'auto');
  assert.deepEqual(schema?.properties.reasoningEffort.enum, ['inherit', 'auto', 'low', 'high', 'max']);
  assert.equal(schema?.properties.reasoningEffort.default, 'inherit');
  assert.equal(schema?.properties.reasoningEffort.group, 'navigation');
  assert.equal(reasoningConfigurationSchema({ ...glm, id: 'unknown' }, 'auto'), undefined);
});

test('a one-million total context reserves output without inflating the advertised total', () => {
  assert.deepEqual(resolveModelLimits({ ...glm, contextWindow: 1000000 }), {
    maxInputTokens: 983616, maxOutputTokens: 16384, contextWindow: 1000000,
  });
  assert.equal(resolveModelLimits({ ...glm, contextWindow: 1000000, maxOutputTokens: 32768 }).maxInputTokens, 967232);
});

test('legacy input-only limits keep their original meaning', () => {
  assert.deepEqual(resolveModelLimits(glm), {
    maxInputTokens: 1000000, maxOutputTokens: 16384, contextWindow: 1016384,
  });
});

test('invalid total budgets fail clearly and discovery preserves an explicit total', () => {
  for (const contextWindow of [0, 16384, 1.5, Number.NaN]) {
    assert.throws(() => resolveModelLimits({ ...glm, contextWindow }), /contextWindow.*must be/);
  }
  const merged = mergeDiscoveredModels([{ ...glm, contextWindow: 1000000 }], [{
    id: glm.id, name: 'Discovered', providerId: glm.providerId, maxInputTokens: 2000000,
  }]);
  assert.equal(resolveModelLimits(merged[0]).contextWindow, 1000000);
});
