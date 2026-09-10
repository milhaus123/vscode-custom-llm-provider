import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import type * as vscode from 'vscode';
import type { ModelConfig } from '../src/modelRegistry';
import type * as providerModule from '../src/provider';

class TextPart { constructor(public value: string) {} }
class DataPart { constructor(public data: Uint8Array, public mimeType: string) {} }
class ToolCallPart { constructor(public callId: string, public name: string, public input: unknown) {} }
class ToolResultPart { constructor(public callId: string, public content: unknown[]) {} }

const model: ModelConfig = {
  id: 'zai-org/GLM-5.3', name: 'GLM', providerId: 'example',
  maxInputTokens: 1000000, maxOutputTokens: 16384, contextWindow: 1000000,
  thinkingEffort: 'low',
};
const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
} as vscode.CancellationToken;

// Execute the actual compiled provider with only VS Code and HTTP replaced.
// No credentials or real endpoint requests are involved.
function loadProvider(version = '1.122.0', responseFactory?: () => Response) {
  const filename = path.join(__dirname, '../src/provider.js');
  const nativeRequire = createRequire(filename);
  const requests: Record<string, any>[] = [];
  const logs: string[] = [];
  const settings: Record<string, unknown> = {
    models: [model], providers: [{ id: 'example', name: 'Example', baseUrl: 'https://example.test/v1' }],
    thinkingEffort: 'max',
  };
  const vscodeMock = {
    version,
    LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
    LanguageModelTextPart: TextPart, LanguageModelDataPart: DataPart,
    LanguageModelToolCallPart: ToolCallPart, LanguageModelToolResultPart: ToolResultPart,
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    workspace: {
      getConfiguration: () => ({ get: (key: string) => settings[key] }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    window: {
      createOutputChannel: () => ({ appendLine: (line: string) => logs.push(line) }),
      showWarningMessage: () => Promise.resolve(undefined),
    },
  };
  const exports = {} as typeof providerModule;
  runInNewContext(readFileSync(filename, 'utf8'), {
    exports, Buffer, TextDecoder, AbortController, Error, setTimeout, clearTimeout,
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    require: (name: string) => {
      if (name === 'vscode') { return vscodeMock; }
      if (name === './http') {
        return {
          ...nativeRequire(name),
          fetchWithRetry: async (_url: string, init: RequestInit) => {
            init.signal?.throwIfAborted();
            requests.push(JSON.parse(String(init.body)));
            return responseFactory?.() ?? new Response(
              'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
            );
          },
        };
      }
      return nativeRequire(name);
    },
  }, { filename });
  const statusBar = { text: '' } as vscode.StatusBarItem;
  const apiKeys = { get: async () => '' } as unknown as ConstructorParameters<typeof exports.CustomLlmProvider>[0];
  return { exports, provider: new exports.CustomLlmProvider(apiKeys, statusBar), requests, logs, statusBar };
}

function message(role: number, text: string): vscode.LanguageModelChatRequestMessage {
  return { role, name: undefined, content: [new TextPart(text)] } as vscode.LanguageModelChatRequestMessage;
}

test('actual converter preserves system instructions, user messages and assistant history', () => {
  const { exports } = loadProvider();
  const converted = exports.toOpenAIMessages([
    message(3, 'System instruction'), message(1, 'Question'), message(2, 'History'),
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(converted)), [
    { role: 'system', content: 'System instruction' },
    { role: 'user', content: 'Question' },
    { role: 'assistant', content: 'History' },
  ]);
  assert.throws(() => exports.toOpenAIMessages([message(99, 'Invalid role')]), /Unsupported message role/);
});

test('registered limits and native reasoning reach the serialized HTTP request correctly', async () => {
  const { provider, requests, logs } = loadProvider();
  const [info] = (await provider.provideLanguageModelChatInformation({ silent: true }, token))!;
  assert.equal(info.maxInputTokens, 983616);
  assert.equal(info.maxOutputTokens, 16384);
  assert.match(info.tooltip ?? '', /Total: 1,000,000/);
  assert.ok('configurationSchema' in info);
  await provider.provideLanguageModelChatResponse(info, [message(3, 'System instruction'), message(1, 'Hello')], {
    toolMode: 1, modelConfiguration: { reasoningEffort: 'high' },
  } as vscode.ProvideLanguageModelChatResponseOptions, { report() {} }, token);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'zai-org/GLM-5.3');
  assert.equal(requests[0].messages[0].role, 'system');
  assert.equal(requests[0].max_tokens, 16384);
  assert.equal(requests[0].reasoning_effort, 'high');
  assert.deepEqual(requests[0].thinking, { type: 'enabled' });
  assert.ok(logs.some(line => line.includes('source=model picker')));
});

test('explicit provider default removes reasoning fields even when defaults are high', async () => {
  const { provider, requests } = loadProvider();
  const [info] = (await provider.provideLanguageModelChatInformation({ silent: true }, token))!;
  await provider.provideLanguageModelChatResponse(info, [message(1, 'Hello')], {
    toolMode: 1, modelOptions: { reasoningEffort: 'auto', unrelated: 'do not forward' },
  }, { report() {} }, token);
  assert.equal(requests[0].reasoning_effort, undefined);
  assert.equal(requests[0].thinking, undefined);
  assert.equal(requests[0].unrelated, undefined);
});

test('older VS Code hosts retain settings controls without the optional native schema', async () => {
  const { provider } = loadProvider('1.119.0');
  const [info] = (await provider.provideLanguageModelChatInformation({ silent: true }, token))!;
  assert.equal('configurationSchema' in info, false);
});

test('a stream failure leaves a warning status instead of a success checkmark', async () => {
  const { provider, statusBar } = loadProvider('1.122.0', () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('Synthetic stream failure')); },
  })));
  const [info] = (await provider.provideLanguageModelChatInformation({ silent: true }, token))!;
  await assert.rejects(provider.provideLanguageModelChatResponse(info, [message(1, 'Hello')], {
    toolMode: 1,
  }, { report() {} }, token), /Synthetic stream failure/);
  assert.match(statusBar.text, /warning/);
});
