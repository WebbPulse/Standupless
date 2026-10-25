/**
 * A request to quote a passage into a comment composer. Each request carries
 * its own number, so quoting the same passage twice still lands twice, and a
 * composer applies each request once however often it renders. Clearing the
 * request when a reply box closes keeps a reopened box from quoting again,
 * and a request made for one issue is dropped once the page shows another.
 */

import { useCallback, useRef, useState } from 'react';

/** One passage to quote, as a Markdown blockquote. */
export interface QuoteRequest {
  markdown: string;
  id: number;
}

/** The latest quote request and the ways to change it. */
export interface QuoteRequests {
  request: QuoteRequest | null;
  /** Makes the next request, for a passage as a Markdown blockquote. */
  ask: (markdown: string) => void;
  /** Drops the request once its composer has gone. */
  clear: () => void;
}

/** What the hook holds between renders. */
interface Held {
  request: QuoteRequest | null;
  scope: string;
  next: number;
}

/** Holds the quote requests for one composer, for the issue named by scope. */
export const useQuoteRequest = (scope = ''): QuoteRequests => {
  const [held, setHeld] = useState<Held>({ request: null, scope, next: 1 });
  const current = useRef(scope);
  current.current = scope;
  const ask = useCallback((markdown: string): void => {
    setHeld((last) => ({
      request: { markdown, id: last.next },
      scope: current.current,
      next: last.next + 1,
    }));
  }, []);
  const clear = useCallback((): void => {
    setHeld((last) =>
      last.request === null ? last : { ...last, request: null }
    );
  }, []);
  return {
    request: held.scope === scope ? held.request : null,
    ask,
    clear,
  };
};
