/**
 * Answers the `#` reference picker as the writer types. Each query waits a
 * moment so a burst of keys costs one request, a newer query aborts the read
 * still in flight, and a query search cannot answer yet costs nothing. Linked
 * pull requests are read beside search, and a failed pull request read only
 * leaves them out, so the issues still answer.
 */

import { useEffect, useState } from 'react';
import { searchPullRequests } from '../api/pullRequests';
import { searchAll } from '../api/views';
import {
  isKeyQuery,
  isSearchable,
  REFERENCE_LIMITS,
  referenceItems,
  type ReferenceItem,
} from '../lib/references';

/** How long typing must pause before the picker searches. */
export const REFERENCE_DEBOUNCE_MS = 150;

/** What the picker shows for the query being typed. */
export interface ReferenceResults {
  /** The query being answered. While it loads, the last answer stays in view. */
  query: string | null;
  items: ReferenceItem[];
  loading: boolean;
}

/**
 * Searches the workspace for the query, or holds nothing when the query is
 * null, too short, or there is no workspace to search.
 */
export const useReferenceResults = (
  workspaceId: string | null,
  query: string | null
): ReferenceResults => {
  const [results, setResults] = useState<ReferenceResults>({
    query: null,
    items: [],
    loading: false,
  });

  useEffect(() => {
    if (workspaceId === null || query === null || !isSearchable(query)) {
      return undefined;
    }
    const controller = new AbortController();
    const text = query.trim();
    const timer = setTimeout(() => {
      const pullRequests = isKeyQuery(text)
        ? Promise.resolve([])
        : searchPullRequests(
            workspaceId,
            text,
            { limit: REFERENCE_LIMITS.pull_request },
            controller.signal
          ).catch(() => []);
      Promise.all([
        searchAll(
          workspaceId,
          text,
          { limit: REFERENCE_LIMITS.issue },
          controller.signal
        ),
        pullRequests,
      ])
        .then(([answer, hits]) => {
          setResults({
            query,
            items: referenceItems(answer, hits),
            loading: false,
          });
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setResults({ query, items: [], loading: false });
        });
    }, REFERENCE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [workspaceId, query]);

  if (workspaceId === null || query === null || !isSearchable(query)) {
    return { query, items: [], loading: false };
  }
  if (results.query !== query) {
    return {
      query,
      items: results.items,
      loading: true,
    };
  }
  return results;
};
