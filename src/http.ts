export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
};

export interface RetryEvent {
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
  status?: number;
  requestId?: string;
}

export class HttpRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly details: string,
    public readonly attempts: number,
    public readonly requestId?: string,
  ) {
    const connectionFailure = status >= 500 && /connection error|connection refused|connecterror|failed to connect/i.test(details);
    super(
      `Custom LLM (${status}): ${details}\n` +
      (connectionFailure
        ? 'The endpoint reported an upstream connection failure. Check the proxy and model-server logs.\n'
        : '') +
      `HTTP attempts: ${attempts}.` + (requestId ? ` Upstream request ID: ${requestId}.` : '')
    );
    this.name = 'HttpRequestError';
  }
}

export class VisionUnsupportedError extends Error {
  constructor(public readonly details: string) {
    super(
      `Custom LLM: This model does not support image input.\n` +
      `The model has been marked as text-only. Select a multimodal model to analyze the image.\n` +
      `Details: ${details}`
    );
    this.name = 'VisionUnsupportedError';
  }
}

function calculateDelay(attempt: number, initialDelayMs: number, maxDelayMs: number): number {
  const exponentialDelay = initialDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay;
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 504);
}

function looksLikeVisionRejection(message: string): boolean {
  const lower = message.toLowerCase();
  const mentionsImage = /\b(image|images|image_url|vision|multi-?modal|visual)\b/.test(lower);
  return mentionsImage && /(not support|unsupported|not allowed|not accept|invalid|cannot|can't|only support)/.test(lower);
}

function parseErrorMessage(errorBody: string): string {
  try {
    const parsed = JSON.parse(errorBody);
    return parsed?.error?.message ?? parsed?.message ?? parsed?.msg ?? errorBody;
  } catch {
    return errorBody;
  }
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function responseRequestId(response: Response): string | undefined {
  const value = response.headers.get('x-request-id')
    ?? response.headers.get('x-litellm-call-id') ?? response.headers.get('request-id');
  return value?.replace(/[\r\n]/g, '').slice(0, 200) || undefined;
}

function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new DOMException('Request cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Retries only transient HTTP/network failures; configuration errors fail immediately. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
  requestHasImages = false,
  onRetry?: (event: RetryEvent) => void,
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    init.signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (init.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= retryConfig.maxRetries) {
        throw lastError;
      }
      const delayMs = calculateDelay(attempt, retryConfig.initialDelayMs, retryConfig.maxDelayMs);
      onRetry?.({ nextAttempt: attempt + 2, maxAttempts: retryConfig.maxRetries + 1, delayMs });
      await wait(delayMs, init.signal);
      continue;
    }

    if (response.ok) {
      return response;
    }

    const status = response.status;
    const errorBody = await response.text().catch(() => 'Unknown error');
    const errorMessage = parseErrorMessage(errorBody);

    if (status === 401 || status === 403) {
      throw new Error(
        'Custom LLM: Invalid, missing, or unauthorized API key.\n' +
        'Open Command Palette (Ctrl+Shift+P) → "Custom LLM: Manage providers" to update it.\n' +
        `Details: ${errorMessage}`
      );
    }

    if (status === 400 && requestHasImages && looksLikeVisionRejection(errorMessage)) {
      throw new VisionUnsupportedError(errorMessage);
    }

    const requestId = responseRequestId(response);
    lastError = new HttpRequestError(status, errorMessage, attempt + 1, requestId);
    if (!isRetryableStatus(status) || attempt >= retryConfig.maxRetries) {
      throw lastError;
    }

    const delay = Math.min(
      retryAfterMs(response) ?? calculateDelay(attempt, retryConfig.initialDelayMs, retryConfig.maxDelayMs),
      retryConfig.maxDelayMs,
    );
    onRetry?.({ nextAttempt: attempt + 2, maxAttempts: retryConfig.maxRetries + 1, delayMs: delay, status, requestId });
    await wait(delay, init.signal);
  }

  throw lastError ?? new Error('Request failed after all retries');
}
