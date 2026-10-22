/**
 * The search behind every parent picker: the top level issues of one team,
 * read from the server as the filter text settles. Sub-issues nest one level
 * deep, so only issues with no parent of their own are offered. The last page
 * stays shown while the next one is read, so the list does not blank on each
 * keystroke.
 */

import { useEffect, useRef, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { listIssues } from '../api/issues';
import { parentSearchKey } from '../lib/queryKeys';
import type { IssueRead } from '../types/Api';

/** The most candidates one search reads. */
const SEARCH_LIMIT = 25;

/** How long typing pauses before the search is read again. */
const SEARCH_DEBOUNCE_MS = 150;

/** How often an open picker re-reads its candidates. */
const SEARCH_POLL_MS = 30000;

/** The search text, settled after a short pause in typing. */
export const useSettled = (value: string): string => {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [value]);
  return settled;
};

/**
 * The candidate parents in a team for the typed query, or null before the
 * first read lands.
 */
export const useParentSearch = (
  workspaceId: string,
  teamId: string,
  query: string,
  enabled = true
): IssueRead[] | null => {
  const auth = useQueryAuth();
  const term = useSettled(query.trim());
  const { data } = usePolledQuery(
    ({ signal }) =>
      listIssues(
        workspaceId,
        {
          team_id: teamId,
          parent_id: 'none',
          sort: 'updated_desc',
          limit: SEARCH_LIMIT,
          ...(term === '' ? {} : { q: term }),
        },
        signal
      ),
    {
      intervalMs: SEARCH_POLL_MS,
      enabled: enabled && workspaceId !== '' && teamId !== '',
      queryKey: parentSearchKey(teamId, term),
      auth,
    }
  );
  const last = useRef(data);
  if (data !== null) last.current = data;
  const found = data ?? last.current;
  return found?.issues ?? null;
};

export default useParentSearch;
