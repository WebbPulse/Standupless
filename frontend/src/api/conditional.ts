/**
 * Conditional reads for polled queries. A read handed the context
 * `usePolledQuery` gives its fetcher sends the held ETag as `If-None-Match`
 * and answers a `PolledResponse`, so the shared query cache keeps the tag and
 * a quiet poll is a bodiless 304. Handed a bare signal, the same read answers
 * the shaped body as it always has, so every other caller is unchanged.
 */

import {
  polledResponse,
  type PolledQueryContext,
  type PolledResponse,
} from '@webbpulse/api-client/react';
import apiClient, { type RequestOptions } from './client';

/**
 * What a read accepts in place of a bare signal: nothing, the caller's signal,
 * or the context `usePolledQuery` hands its fetcher.
 */
export type ReadContext = AbortSignal | PolledQueryContext | undefined;

/** Whether a read was handed a polled query's context rather than a signal. */
export const isPolledContext = (
  context: ReadContext
): context is PolledQueryContext =>
  context !== undefined && !(context instanceof AbortSignal);

/**
 * One GET whose body `read` shapes into what the caller holds. `options`
 * builds the request options from the signal, the way the read always has.
 * `read` tolerates the empty body of a 304, whose shaped value is ignored.
 * Given a polled query's context, the context's conditional headers are
 * merged in and the answer is a `PolledResponse`.
 */
export async function conditionalGet<Body, T>(
  path: string,
  options: (signal: AbortSignal | undefined) => RequestOptions | undefined,
  context: ReadContext,
  read: (body: Body) => T
): Promise<T | PolledResponse<T>> {
  if (!isPolledContext(context)) {
    const response = await apiClient.get<Body>(path, options(context));
    return read(response.data);
  }
  const base = options(context.signal);
  const response = await apiClient.get<Body>(path, {
    ...base,
    headers: { ...base?.headers, ...context.headers },
  });
  return polledResponse({
    status: response.status,
    headers: response.headers,
    data: read(response.data),
  });
}
