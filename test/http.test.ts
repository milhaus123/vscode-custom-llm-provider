import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpRequestError, RetryEvent, VisionUnsupportedError, fetchWithRetry } from '../src/http';

const noDelay = { maxRetries: 3, initialDelayMs: 0, maxDelayMs: 0 };

test('does not retry a non-transient 400 response', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: 'bad parameter' } }), { status: 400 });
  };
  try {
    await assert.rejects(fetchWithRetry('https://example.test', {}, noDelay), /Custom LLM \(400\)/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('retries a transient 429 response', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response('rate limited', { status: 429 })
      : new Response('ok', { status: 200 });
  };
  try {
    const response = await fetchWithRetry('https://example.test', {}, noDelay);
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('classifies and does not retry an image rejection', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({
      error: { message: "Model only supports text input; received unsupported content type 'image_url'." },
    }), { status: 400 });
  };
  try {
    await assert.rejects(
      fetchWithRetry('https://example.test', {}, noDelay, true),
      VisionUnsupportedError,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('does not retry an aborted request', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    const error = new Error('cancelled');
    error.name = 'AbortError';
    throw error;
  };
  try {
    await assert.rejects(
      fetchWithRetry('https://example.test', {}, noDelay),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('upstream connection failures report attempts and the server request ID', async () => {
  const originalFetch = globalThis.fetch;
  const retries: RetryEvent[] = [];
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: 'litellm.InternalServerError: Connection error.' } }), {
      status: 500, headers: { 'x-litellm-call-id': 'upstream-example-id' },
    });
  };
  try {
    await assert.rejects(fetchWithRetry('https://example.test', {}, noDelay, false, event => retries.push(event)),
      (error: unknown) => {
        assert.ok(error instanceof HttpRequestError);
        assert.equal(error.attempts, 4);
        assert.equal(error.requestId, 'upstream-example-id');
        assert.match(error.message, /proxy and model-server logs/);
        return true;
      });
    assert.equal(calls, 4);
    assert.deepEqual(retries.map(event => event.nextAttempt), [2, 3, 4]);
  } finally { globalThis.fetch = originalFetch; }
});

test('cancellation interrupts retry backoff without another HTTP attempt', async () => {
  const originalFetch = globalThis.fetch;
  const abort = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('busy', { status: 503 }); };
  try {
    await assert.rejects(fetchWithRetry('https://example.test', { signal: abort.signal }, {
      maxRetries: 3, initialDelayMs: 10000, maxDelayMs: 10000,
    }, false, () => { setImmediate(() => abort.abort()); }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});
