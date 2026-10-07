/**
 * The product client must carry the signed in user's identity on every call.
 *
 * Every other module under `src/api` mocks `./client`, so each one proves its own
 * path and body while nobody proves that the client those paths are spent on sends
 * who the caller is. That gap is how a whole application signs in, renders, and
 * then answers 401 to every product request: the access token lives only in the
 * identity client's memory, and a product client built without `auth` reads it
 * from nowhere.
 *
 * So this drives the real client against a stubbed `fetch` rather than a mocked
 * module, and asserts on what reached the wire: the bearer header taken from the
 * identity client, and `credentials: 'include'`, which the refresh cookie the
 * session depends on is only sent under.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ACCESS_TOKEN = 'header.payload.signature';

/** One captured `fetch` call, reduced to what these assertions are about. */
interface Captured {
  authorization: string | null;
  credentials: RequestCredentials | undefined;
  method: string;
}

const captured: Captured[] = [];

/**
 * A `fetch` stub that records each request and answers an empty JSON object.
 *
 * Answers 200 with a body rather than 204 so the shared client takes its ordinary
 * parse path: a bodyless answer would exercise the empty branch instead of the
 * header behaviour under test.
 */
const stubFetch = (): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {});
      captured.push({
        authorization: headers.get('authorization'),
        credentials: init?.credentials,
        method: (init?.method ?? 'GET').toUpperCase(),
      });
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    })
  );
};

/**
 * Imports the product client with a signed in identity behind it.
 *
 * The identity client is built and given a token before `./client` is imported,
 * because `client.ts` reads `getIdentityClient()` once at module scope. Importing
 * in the other order would build the product client against a null provider and
 * the test would assert about that instead.
 */
const importClientSignedIn = async (): Promise<{
  apiClient: typeof import('./client').apiClient;
}> => {
  const identity = await import('./identityClient');
  const authClient = identity.getIdentityClient();
  if (authClient === null) {
    throw new Error(
      'the identity client could not be built, so nothing holds a token'
    );
  }
  vi.spyOn(authClient, 'getAccessToken').mockReturnValue(ACCESS_TOKEN);
  vi.spyOn(authClient, 'waitForToken').mockResolvedValue(ACCESS_TOKEN);
  return import('./client');
};

describe('the product API client', () => {
  beforeEach(() => {
    captured.length = 0;
    vi.resetModules();
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends the identity client access token as a bearer header', async () => {
    const { apiClient } = await importClientSignedIn();

    await apiClient.get('/workspaces');

    expect(captured).toHaveLength(1);
    expect(captured[0]?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('sends the bearer header on a write as well as a read', async () => {
    const { apiClient } = await importClientSignedIn();

    await apiClient.post('/workspaces', { name: 'a workspace' });

    expect(captured[0]?.method).toBe('POST');
    expect(captured[0]?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('sends credentials include, so the refresh cookie travels', async () => {
    const { apiClient } = await importClientSignedIn();

    await apiClient.get('/workspaces');

    expect(captured[0]?.credentials).toBe('include');
  });

  it('is built against the identity client rather than no auth provider at all', async () => {
    const identity = await import('./identityClient');
    const authClient = identity.getIdentityClient();
    if (authClient === null) {
      throw new Error(
        'the identity client could not be built, so nothing holds a token'
      );
    }
    const token = vi
      .spyOn(authClient, 'waitForToken')
      .mockResolvedValue(ACCESS_TOKEN);
    vi.spyOn(authClient, 'getAccessToken').mockReturnValue(ACCESS_TOKEN);

    const { apiClient } = await import('./client');
    await apiClient.get('/workspaces');

    expect(token).toHaveBeenCalled();
  });

  it('refreshes and replays once when the gateway authorizer denies an expired token', async () => {
    const answers = [
      new Response(JSON.stringify({ message: 'Forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(JSON.stringify({ workspaces: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ];
    const fetchStub = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        authorization: new Headers(init?.headers ?? {}).get('authorization'),
        credentials: init?.credentials,
        method: (init?.method ?? 'GET').toUpperCase(),
      });
      return Promise.resolve(
        answers.shift() ?? new Response(null, { status: 500 })
      );
    });
    vi.stubGlobal('fetch', fetchStub);
    const identity = await import('./identityClient');
    const authClient = identity.getIdentityClient();
    if (authClient === null) {
      throw new Error(
        'the identity client could not be built, so nothing holds a token'
      );
    }
    const tokens = ['expired.token.signature', ACCESS_TOKEN];
    vi.spyOn(authClient, 'getAccessToken').mockImplementation(
      () => tokens[0] ?? null
    );
    vi.spyOn(authClient, 'waitForToken').mockImplementation(() =>
      Promise.resolve(tokens[0] ?? null)
    );
    const refresh = vi.spyOn(authClient, 'refresh').mockImplementation(() => {
      tokens.shift();
      return Promise.resolve(ACCESS_TOKEN);
    });
    const { apiClient } = await import('./client');

    const read = await apiClient.get<{ workspaces: unknown[] }>('/workspaces');

    expect(read).toMatchObject({ status: 200, data: { workspaces: [] } });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(captured[0]?.authorization).toBe('Bearer expired.token.signature');
    expect(captured[1]?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('surfaces a backend 403 as a 403, with no refresh', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              success: false,
              status: 403,
              message: 'Forbidden',
              request_id: 'req-1',
            }),
            { status: 403, headers: { 'content-type': 'application/json' } }
          )
        )
      )
    );
    const identity = await import('./identityClient');
    const authClient = identity.getIdentityClient();
    if (authClient === null) {
      throw new Error(
        'the identity client could not be built, so nothing holds a token'
      );
    }
    vi.spyOn(authClient, 'getAccessToken').mockReturnValue(ACCESS_TOKEN);
    vi.spyOn(authClient, 'waitForToken').mockResolvedValue(ACCESS_TOKEN);
    const refresh = vi.spyOn(authClient, 'refresh');
    const { apiClient } = await import('./client');

    await expect(apiClient.get('/workspaces')).rejects.toMatchObject({
      status: 403,
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('waits out a 429 longer than the shared client would, instead of throwing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const answers = [
        new Response(JSON.stringify({ detail: 'Too many requests' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'Retry-After': '20' },
        }),
        new Response(JSON.stringify({ workspaces: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ];
      const fetchStub = vi.fn(() =>
        Promise.resolve(answers.shift() ?? new Response(null, { status: 500 }))
      );
      vi.stubGlobal('fetch', fetchStub);
      const { apiClient } = await importClientSignedIn();

      const read = apiClient.get<{ workspaces: unknown[] }>('/workspaces');
      await vi.advanceTimersByTimeAsync(19000);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);

      await expect(read).resolves.toMatchObject({
        status: 200,
        data: { workspaces: [] },
      });
      expect(fetchStub).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
