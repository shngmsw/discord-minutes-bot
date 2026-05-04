import { logger } from './logger.js';

interface RetryOpts {
  retries?: number;
  baseMs?: number;
  label?: string;
}

const RETRYABLE_CODES = new Set([429, 500, 502, 503, 504]);

function statusCodeOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const anyErr = err as { status?: number; code?: number; message?: string };
  if (typeof anyErr.status === 'number') return anyErr.status;
  if (typeof anyErr.code === 'number') return anyErr.code;
  // Gemini SDK often throws with stringified JSON in message
  if (typeof anyErr.message === 'string') {
    const m = anyErr.message.match(/"code"\s*:\s*(\d{3})/);
    if (m && m[1]) return Number(m[1]);
  }
  return undefined;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const retries = opts.retries ?? 4;
  const baseMs = opts.baseMs ?? 2000;
  const label = opts.label ?? 'retryable op';

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const status = statusCodeOf(err);
      const retryable = status !== undefined && RETRYABLE_CODES.has(status);
      if (!retryable || attempt >= retries) {
        throw err;
      }
      const delay = baseMs * 2 ** attempt + Math.random() * 500;
      logger.warn(
        { label, attempt: attempt + 1, status, delayMs: Math.round(delay) },
        'retrying after transient error',
      );
      await new Promise((r) => setTimeout(r, delay));
      attempt += 1;
    }
  }
}
