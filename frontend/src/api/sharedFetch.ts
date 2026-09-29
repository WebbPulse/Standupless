/**
 * The `fetch` the product client sends through. It does two things the shared
 * client leaves to the application.
 *
 * Identical reads share one request. A GET already in flight hands its answer
 * to every caller that asks for the same URL under the same credentials, and a
 * successful answer is reused for a moment after it lands, so the components
 * that mount together on a page load, and a StrictMode remount, cost the API
 * one read instead of one each. Any write empties the reuse window, so a read
 * that follows a write always goes to the API.
 *
 * A 429 is waited out rather than surfaced. The wait comes from `Retry-After`,
 * or from the `RateLimit-Reset`, `X-RateLimit-Reset` or `RateLimit` `t=` fields
 * when that is all the answer carries, and falls back to an exponential backoff
 * when it carries none. The wait pauses every request this page sends, since
 * the rest would only spend the same exhausted allowance. The limiter refuses
 * before a handler runs, so replaying a refused write is safe.
 */

/** How long a successful read is reused after it lands, in milliseconds. */
export const SHARED_GET_FRESH_MS = 2000;

/** How many times a 429 is waited out before it reaches the caller. */
export const RATE_LIMIT_RETRIES = 4;

/** The longest single wait a 429 earns, in milliseconds. */
export const RATE_LIMIT_MAX_WAIT_MS = 60000;

/** The first fallback wait when a 429 names no reset, in milliseconds. */
export const RATE_LIMIT_BASE_WAIT_MS = 1000;

/** One read, shared by every caller that asks for it while it is live. */
interface SharedRead {
  response: Promise<Response>;
  controller: AbortController;
  subscribers: number;
  settledAt: number | null;
  pendingAbort: ReturnType<typeof setTimeout> | null;
}

const reads = new Map<string, SharedRead>();

let pausedUntil = 0;

/** Forgets every shared read and any rate limit pause, for tests and sign out. */
export const clearSharedGetCache = (): void => {
  reads.clear();
  pausedUntil = 0;
};

/** The error `fetch` rejects with when its signal aborts. */
const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');

/** Any rejection as an Error, which is all `fetch` ever rejects with. */
const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
const wait = (ms: number, signal: AbortSignal | null | undefined) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      if (signal !== null && signal !== undefined) reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Reads a seconds count, or an HTTP date, into milliseconds from now. */
const secondsOrDate = (value: string | null, now: number): number | null => {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds > 1e9 ? seconds * 1000 - now : seconds * 1000;
  }
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : at - now;
};

/**
 * How long a 429 asks the caller to wait, in milliseconds, or null when it
 * names no reset. A reset count too large to be a delay is read as an epoch.
 */
export const rateLimitWaitMs = (
  headers: Headers,
  now: number = Date.now()
): number | null => {
  const candidates = [
    secondsOrDate(headers.get('retry-after'), now),
    secondsOrDate(headers.get('ratelimit-reset'), now),
    secondsOrDate(headers.get('x-ratelimit-reset'), now),
    secondsOrDate(
      /(?:^|;)\s*t=(\d+)/.exec(headers.get('ratelimit') ?? '')?.[1] ?? null,
      now
    ),
  ];
  const found = candidates.find((ms) => ms !== null);
  return found === undefined || found === null ? null : Math.max(0, found);
};

/** The fallback wait for the nth refusal that named no reset. */
const backoffMs = (attempt: number): number =>
  RATE_LIMIT_BASE_WAIT_MS * 2 ** attempt * (0.5 + Math.random() / 2);

/**
 * Sends one request, holding it while the page is paused and waiting out each
 * 429 up to {@link RATE_LIMIT_RETRIES} times.
 */
const sendRespectingRateLimit = async (
  input: RequestInfo | URL,
  init: RequestInit | undefined
): Promise<Response> => {
  const signal = init?.signal;
  for (let attempt = 0; ; attempt += 1) {
    const pause = pausedUntil - Date.now();
    if (pause > 0) await wait(pause, signal);
    const response = await globalThis.fetch(input, init);
    if (response.status !== 429 || attempt >= RATE_LIMIT_RETRIES) {
      return response;
    }
    const named = rateLimitWaitMs(response.headers);
    const delay = Math.min(RATE_LIMIT_MAX_WAIT_MS, named ?? backoffMs(attempt));
    pausedUntil = Math.max(pausedUntil, Date.now() + delay);
    await response.body?.cancel().catch(() => undefined);
  }
};

/** The URL of a request, whatever form `fetch` was handed it in. */
const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

/** Names a read by what the API answers on: its URL and credentials. */
const readKey = (input: RequestInfo | URL, init?: RequestInit): string => {
  const headers = new Headers(init?.headers);
  return `${headers.get('authorization') ?? ''} ${urlOf(input)}`;
};

/** Whether this request is a read that may be shared. */
const isSharedRead = (input: RequestInfo | URL, init?: RequestInit): boolean =>
  (
    init?.method ?? (input instanceof Request ? input.method : 'GET')
  ).toUpperCase() === 'GET' &&
  (init?.body === undefined || init.body === null);

/** Whether a shared read may still hand out its answer. */
const isLive = (read: SharedRead, now: number): boolean =>
  read.settledAt === null || now - read.settledAt < SHARED_GET_FRESH_MS;

/** Drops the settled reads whose reuse window has closed. */
const prune = (now: number): void => {
  for (const [key, read] of reads) {
    if (!isLive(read, now)) reads.delete(key);
  }
};

/** Starts the one request a shared read waits on. */
const startRead = (
  key: string,
  input: RequestInfo | URL,
  init: RequestInit | undefined
): SharedRead => {
  const controller = new AbortController();
  const read: SharedRead = {
    controller,
    subscribers: 0,
    settledAt: null,
    pendingAbort: null,
    response: Promise.resolve(new Response(null)),
  };
  read.response = sendRespectingRateLimit(input, {
    ...init,
    signal: controller.signal,
  }).then(
    (response) => {
      if (response.ok && reads.get(key) === read) {
        read.settledAt = Date.now();
      } else if (reads.get(key) === read) {
        reads.delete(key);
      }
      return response;
    },
    (error: unknown) => {
      if (reads.get(key) === read) reads.delete(key);
      throw error;
    }
  );
  read.response.catch(() => undefined);
  reads.set(key, read);
  return read;
};

/**
 * Joins a caller to a shared read. The caller gets its own copy of the answer,
 * and its abort leaves the others waiting; the request itself is aborted only
 * once nobody is left waiting on it, a tick later, so a StrictMode remount can
 * rejoin it first.
 */
const joinRead = (
  key: string,
  read: SharedRead,
  signal: AbortSignal | null | undefined
): Promise<Response> => {
  if (read.pendingAbort !== null) {
    clearTimeout(read.pendingAbort);
    read.pendingAbort = null;
  }
  read.subscribers += 1;
  return new Promise<Response>((resolve, reject) => {
    let done = false;
    const leave = (): void => {
      done = true;
      read.subscribers -= 1;
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      if (done) return;
      leave();
      if (signal !== null && signal !== undefined) reject(abortError(signal));
      if (read.subscribers === 0 && read.settledAt === null) {
        read.pendingAbort = setTimeout(() => {
          read.pendingAbort = null;
          if (read.subscribers > 0 || read.settledAt !== null) return;
          if (reads.get(key) === read) reads.delete(key);
          read.controller.abort();
        }, 0);
      }
    };
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    read.response.then(
      (response) => {
        if (done) return;
        leave();
        resolve(response.clone());
      },
      (error: unknown) => {
        if (done) return;
        leave();
        reject(asError(error));
      }
    );
  });
};

/** A drop-in `fetch` that shares identical reads and waits out rate limits. */
export const sharedFetch: typeof globalThis.fetch = (input, init) => {
  if (!isSharedRead(input, init)) {
    reads.clear();
    const settle = (): void => reads.clear();
    const sent = sendRespectingRateLimit(input, init);
    sent.then(settle, settle);
    return sent;
  }
  prune(Date.now());
  const key = readKey(input, init);
  const read = reads.get(key) ?? startRead(key, input, init);
  return joinRead(key, read, init?.signal);
};
