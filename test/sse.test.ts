import assert from 'node:assert/strict';
import test from 'node:test';
import { SseDataParser } from '../src/sse';

test('parses data split across chunks', () => {
  const parser = new SseDataParser();
  assert.deepEqual(parser.push('data: {"a"'), []);
  assert.deepEqual(parser.push(':1}\n\ndata: [DONE]\n'), ['{"a":1}', '[DONE]']);
});

test('flushes a final event when the stream closes without a newline', () => {
  const parser = new SseDataParser();
  assert.deepEqual(parser.push('data: {"last":true}'), []);
  assert.deepEqual(parser.finish(), ['{"last":true}']);
});
