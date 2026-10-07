/**
 * Reads the API gateway's authorizer denial as the lost session it is.
 *
 * Production checks access tokens in the gateway's Lambda authorizer, and
 * staging in the access gate's. Both are HTTP API authorizers, which can only
 * deny with a 403 whose body is `{"message":"Forbidden"}`. They deny only for
 * a missing, invalid or expired token, so the denial means what a 401 means,
 * but the shared client refreshes and replays on a 401 alone. A tab that slept
 * past its token's expiry would otherwise show errors instead of recovering.
 *
 * The backend never answers in that shape: its error envelope always carries
 * `success`, `status` and `request_id`. So a 403 whose body is exactly the
 * gateway's, on a request that sent a bearer token, is handed on as a 401 and
 * every other answer passes through untouched.
 */

/** The body an HTTP API authorizer denial answers with. */
const GATEWAY_DENIAL_MESSAGE = 'Forbidden';

/** Whether the request carried a bearer token the authorizer could reject. */
const sentBearer = (input: RequestInfo | URL, init?: RequestInit): boolean => {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined)
  );
  return /^bearer\s/i.test(headers.get('authorization') ?? '');
};

/** Whether a response body is the gateway's denial and nothing else. */
export const isGatewayDenialBody = (text: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return false;
    }
    const keys = Object.keys(parsed);
    return (
      keys.length === 1 &&
      keys[0] === 'message' &&
      (parsed as { message: unknown }).message === GATEWAY_DENIAL_MESSAGE
    );
  } catch {
    return false;
  }
};

/** Wraps a `fetch` so a gateway authorizer denial reaches the client as a 401. */
export const withAuthorizerDenialAsUnauthorized =
  (fetchImpl: typeof globalThis.fetch): typeof globalThis.fetch =>
  async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.status !== 403 || !sentBearer(input, init)) {
      return response;
    }
    const text = await response.clone().text();
    if (!isGatewayDenialBody(text)) {
      return response;
    }
    return new Response(text, {
      status: 401,
      statusText: 'Unauthorized',
      headers: response.headers,
    });
  };
