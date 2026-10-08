/**
 * The product client's `fetch`: identical reads share one request, a write
 * ends the reuse window, one caller's abort leaves the others their answer,
 * and a rate limit 429 is waited out for as long as the API asks instead of
 * reaching the page as an error, while a lockout 429 reaches its caller at once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSharedGetCache,
  RATE_LIMIT_RETRIES,
  rateLimitWaitMs,
  SHARED_GET_FRESH_MS,
  sharedFetch,
} from './sharedFetch';

const URL_A = 'https://api.example.test/api/workspaces/ws-1/projects';

/** A pending answer the test settles by hand. */
interface Pending {
  url: string;
  method: string;
  signal: AbortSignal | null | undefined;
  resolve: (response: Response) => void;
}

const pending: Pending[] = [];

/** A JSON answer with the given status and headers. */
const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

beforeEach(() => {
  clearSharedGetCache();
  pending.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
          pending.push({
            url:
              typeof input === 'string'
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url,
            method: (init?.method ?? 'GET').toUpperCase(),
            signal,
            resolve,
          });
        })
    )
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Lets the queued promise callbacks run. */
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe('shared reads', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('sends identical reads in flight together once, each with its own body', async () => {
    const first = sharedFetch(URL_A);
    const second = sharedFetch(URL_A);
    await flush();
    expect(pending).toHaveLength(1);

    pending[0]?.resolve(json({ projects: [] }));
    const [a, b] = await Promise.all([first, second]);
    await expect(a.json()).resolves.toEqual({ projects: [] });
    await expect(b.json()).resolves.toEqual({ projects: [] });
  });

  it('reuses a landed read briefly, then reads again', async () => {
    const first = sharedFetch(URL_A);
    await flush();
    pending[0]?.resolve(json({ n: 1 }));
    await first;

    await sharedFetch(URL_A);
    expect(pending).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(SHARED_GET_FRESH_MS);
    void sharedFetch(URL_A);
    await flush();
    expect(pending).toHaveLength(2);
  });

  it('keeps reads under different credentials apart', async () => {
    void sharedFetch(URL_A, { headers: { authorization: 'Bearer a' } });
    void sharedFetch(URL_A, { headers: { authorization: 'Bearer b' } });
    await flush();
    expect(pending).toHaveLength(2);
  });

  it('keeps a conditional read apart from a plain one', async () => {
    void sharedFetch(URL_A);
    void sharedFetch(URL_A, { headers: { 'If-None-Match': 'W/"one"' } });
    await flush();
    expect(pending).toHaveLength(2);
  });

  it('reads again after a write', async () => {
    const first = sharedFetch(URL_A);
    await flush();
    pending[0]?.resolve(json({ n: 1 }));
    await first;

    const write = sharedFetch(URL_A, { method: 'POST', body: '{}' });
    await flush();
    pending[1]?.resolve(json({ ok: true }, 201));
    await write;

    void sharedFetch(URL_A);
    await flush();
    expect(pending.map((call) => call.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('answers the callers still waiting when one of them aborts', async () => {
    const leaving = new AbortController();
    const first = sharedFetch(URL_A, { signal: leaving.signal });
    const second = sharedFetch(URL_A);
    await flush();
    leaving.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    await flush();
    expect(pending[0]?.signal?.aborted).toBe(false);
    pending[0]?.resolve(json({ n: 1 }));
    await expect((await second).json()).resolves.toEqual({ n: 1 });
  });

  it('aborts the request once every caller has left', async () => {
    const only = new AbortController();
    const call = sharedFetch(URL_A, { signal: only.signal });
    await flush();
    only.abort();
    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    expect(pending[0]?.signal?.aborted).toBe(true);
  });
});

describe('rate limits', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('waits out a 429 for the Retry-After it names and answers the retry', async () => {
    const call = sharedFetch(URL_A);
    await flush();
    pending[0]?.resolve(
      json({ detail: 'slow down' }, 429, { 'Retry-After': '3' })
    );
    await flush();

    await vi.advanceTimersByTimeAsync(2900);
    expect(pending).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(pending).toHaveLength(2);

    pending[1]?.resolve(json({ projects: [] }));
    const response = await call;
    expect(response.status).toBe(200);
  });

  it('hands a lockout 429 straight back and pauses nothing', async () => {
    const call = sharedFetch(`${URL_A}/step-up`, {
      method: 'POST',
      body: '{}',
    });
    await flush();
    pending[0]?.resolve(
      json({ error_code: 'TOO_MANY_ATTEMPTS', detail: 'locked' }, 429, {
        'Retry-After': '300',
      })
    );
    const response = await call;
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('300');
    await expect(response.json()).resolves.toMatchObject({
      error_code: 'TOO_MANY_ATTEMPTS',
    });

    void sharedFetch(`${URL_A}/other`);
    await flush();
    expect(pending.map((c) => c.url)).toEqual([
      `${URL_A}/step-up`,
      `${URL_A}/other`,
    ]);
  });

  it('still waits out a rate limit 429 that carries another code', async () => {
    const call = sharedFetch(URL_A);
    await flush();
    pending[0]?.resolve(
      json({ error_code: 'RATE_LIMITED' }, 429, { 'Retry-After': '1' })
    );
    await flush();
    expect(pending).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pending).toHaveLength(2);
    pending[1]?.resolve(json({}));
    await expect(call).resolves.toMatchObject({ status: 200 });
  });

  it('holds every other request until the pause ends', async () => {
    const call = sharedFetch(URL_A);
    await flush();
    pending[0]?.resolve(json({}, 429, { 'RateLimit-Reset': '2' }));
    await flush();

    void sharedFetch(`${URL_A}/other`);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pending).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(pending.map((c) => c.url)).toEqual([URL_A, URL_A, `${URL_A}/other`]);
    pending[1]?.resolve(json({}));
    await expect(call).resolves.toMatchObject({ status: 200 });
  });

  it('backs off without a named reset and hands over the last 429 when retries run out', async () => {
    const call = sharedFetch(URL_A);
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
      await vi.advanceTimersByTimeAsync(60000);
      pending[attempt]?.resolve(json({}, 429));
    }
    await vi.advanceTimersByTimeAsync(0);
    const response = await call;
    expect(response.status).toBe(429);
    expect(pending).toHaveLength(RATE_LIMIT_RETRIES + 1);
  });
});

describe('rateLimitWaitMs', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');

  it('reads Retry-After seconds first', () => {
    const headers = new Headers({ 'Retry-After': '5', 'RateLimit-Reset': '9' });
    expect(rateLimitWaitMs(headers, now)).toBe(5000);
  });

  it('reads a Retry-After date', () => {
    const headers = new Headers({
      'Retry-After': new Date(now + 4000).toUTCString(),
    });
    expect(rateLimitWaitMs(headers, now)).toBe(4000);
  });

  it('falls back to RateLimit-Reset, including an epoch', () => {
    expect(rateLimitWaitMs(new Headers({ 'RateLimit-Reset': '7' }), now)).toBe(
      7000
    );
    expect(
      rateLimitWaitMs(
        new Headers({ 'X-RateLimit-Reset': String(now / 1000 + 12) }),
        now
      )
    ).toBe(12000);
  });

  it('reads the reset out of the structured RateLimit field', () => {
    const headers = new Headers({ RateLimit: '"get";r=0;t=11' });
    expect(rateLimitWaitMs(headers, now)).toBe(11000);
  });

  it('answers null when nothing names a reset', () => {
    expect(rateLimitWaitMs(new Headers(), now)).toBeNull();
  });
});
