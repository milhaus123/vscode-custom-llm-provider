import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildThinkingParams,
  findModelByRegistrationId,
  mergeDiscoveredModels,
  modelRegistrationId,
  resolveCapabilities,
} from '../src/modelRegistry';

test('namespaced GLM-5.3 uses the GLM reasoning adapter', () => {
  assert.deepEqual(buildThinkingParams('zai-org/GLM-5.3', 'high', 32768).params, {
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
  });
  assert.deepEqual(buildThinkingParams('proxy/zai-org/GLM-5.3', 'max', 32768).params, {
    thinking: { type: 'enabled' },
    reasoning_effort: 'max',
  });
});

test('GLM-5.3 cannot silently disable thinking', () => {
  const result = buildThinkingParams('zai-org/GLM-5.3', 'off', 32768);
  assert.deepEqual(result.params, {
    thinking: { type: 'enabled' },
    reasoning_effort: 'low',
  });
  assert.match(result.warning ?? '', /cannot disable thinking/i);
});

test('namespaced Qwen models retain their thinking budget adapter', () => {
  assert.deepEqual(buildThinkingParams('company/qwen3-coder-plus', 'low', 8192).params, {
    enable_thinking: true,
    thinking_budget: 1024,
  });
});

test('unknown capabilities fail closed', () => {
  assert.deepEqual(resolveCapabilities({ id: 'vendor/new-model' }), {
    imageInput: false,
    toolCalling: false,
    imageSource: 'safe-default',
    toolSource: 'safe-default',
  });
});

test('GLM-5.3 is text-only unless explicitly overridden', () => {
  const defaults = resolveCapabilities({ id: 'zai-org/GLM-5.3' });
  assert.equal(defaults.imageInput, false);
  assert.equal(defaults.toolCalling, true);
  assert.equal(resolveCapabilities({ id: 'zai-org/GLM-5.3', imageInput: true }).imageInput, true);
});

test('discovery preserves per-model overrides', () => {
  const existing = [{
    id: 'zai-org/GLM-5.3',
    name: 'My GLM',
    providerId: 'litellm',
    maxInputTokens: 100,
    maxOutputTokens: 200,
    imageInput: false,
    toolCalling: true,
    hidden: false,
    thinkingEffort: 'high' as const,
  }];
  const merged = mergeDiscoveredModels(existing, [{
    id: 'zai-org/GLM-5.3',
    name: 'Discovered GLM',
    providerId: 'litellm',
    maxInputTokens: 999,
    maxOutputTokens: 999,
    imageInput: true,
  }]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, 'My GLM');
  assert.equal(merged[0].maxOutputTokens, 200);
  assert.equal(merged[0].imageInput, false);
  assert.equal(merged[0].thinkingEffort, 'high');
});

test('equal upstream model IDs from different providers coexist', () => {
  const merged = mergeDiscoveredModels([], [
    { id: 'shared-model', name: 'One', providerId: 'one' },
    { id: 'shared-model', name: 'Two', providerId: 'two' },
  ]);
  assert.equal(merged.length, 2);
  assert.notEqual(
    modelRegistrationId(merged[0].providerId, merged[0].id),
    modelRegistrationId(merged[1].providerId, merged[1].id),
  );
});

test('model lookup accepts qualified IDs and unambiguous legacy IDs', () => {
  const models = [
    { id: 'shared-model', name: 'One', providerId: 'one', maxInputTokens: 8192, maxOutputTokens: 2048 },
    { id: 'unique-model', name: 'Two', providerId: 'two', maxInputTokens: 8192, maxOutputTokens: 2048 },
  ];
  assert.equal(findModelByRegistrationId(models, 'one::shared-model')?.providerId, 'one');
  assert.equal(findModelByRegistrationId(models, 'unique-model')?.providerId, 'two');
});
