/**
 * Search across the teams a person can see. The result set is capped rather
 * than paged, because the contract does not mint a cursor over an intersection
 * of posting lists, so this page offers a narrower term instead of a next page.
 *
 * An exact issue key short circuits to that issue, since typing a key is the
 * most common search and the index is not the right answer for it.
 */

import React, { useCallback, useDeferredValue, useState } from 'react';
import { LuSearch } from 'react-icons/lu';
import { Link, useNavigate } from 'react-router-dom';
import { search } from '../../api/views';
import { listTeams } from '../../api/teams';
import { ErrorAlert } from '../../components/ui/alert';
import EmptyState from '../../components/ui/empty-state';
import Input from '../../components/ui/input';
import Label from '../../components/ui/label';
import TextLink from '../../components/ui/link';
import { SelectField } from '../../components/ui/select';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { m3ErrorMessage } from '../../lib/errors';
import { teamsKey, searchKey } from '../../lib/queryKeys';
import {
  hasIndexableTerm,
  isIssueKey,
  isPartialIssueKey,
} from '../../lib/searchTerms';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { useQueryAuth } from '@webbpulse/auth/react';

/** How many hits the route is asked for, which is also what it caps at. */
const RESULT_LIMIT = 50;

/** How often a search re-reads while its term is unchanged. */
const POLL_MS = 60000;

/** How often the team list re-reads. */
const TEAMS_POLL_MS = 60000;

/** Searches issues by title and body across the visible teams. */
export const Search: React.FC = () => {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const auth = useQueryAuth();
  const [term, setTerm] = useState('');
  const [teamId, setTeamId] = useState('');

  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';

  const deferred = useDeferredValue(term).trim();
  const isKey = isIssueKey(deferred);
  const isPartialKey = isPartialIssueKey(deferred);
  const indexable = hasIndexableTerm(deferred);
  const enabled =
    workspaceId !== '' &&
    deferred !== '' &&
    indexable &&
    !isKey &&
    !isPartialKey;

  const { data: teams } = usePolledQuery(
    ({ signal }) => listTeams(workspaceId, signal),
    {
      intervalMs: TEAMS_POLL_MS,
      enabled: workspaceId !== '',
      queryKey: teamsKey(workspaceId),
      auth,
    }
  );

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) =>
      search(
        workspaceId,
        deferred,
        {
          ...(teamId === '' ? {} : { team_id: teamId }),
          limit: RESULT_LIMIT,
        },
        signal
      ),
    {
      intervalMs: POLL_MS,
      enabled,
      queryKey: searchKey(workspaceId, deferred, teamId),
      auth,
    }
  );

  const goToKey = useCallback(() => {
    if (!isKey) return;
    void navigate(`/w/${slug}/issues/${deferred.toUpperCase()}`);
  }, [isKey, navigate, slug, deferred]);

  const results = data ?? [];

  return (
    <WorkspaceShell
      title="Search"
      toolbar={
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            goToKey();
          }}
        >
          <div className="relative w-72">
            <Label htmlFor="search-term" hidden>
              Find issues
            </Label>
            <LuSearch
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-text-faint"
            />
            <Input
              id="search-term"
              type="search"
              className="pl-8"
              placeholder="Words from a title or body, or an issue key"
              autoComplete="off"
              value={term}
              autoFocus
              onChange={(event) => {
                setTerm(event.target.value);
              }}
            />
          </div>
          <SelectField
            id="search-team"
            label="Team"
            hideLabel
            className="w-44"
            value={teamId}
            onChange={(event) => {
              setTeamId(event.target.value);
            }}
          >
            <option value="">Every team</option>
            {(teams ?? []).map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </SelectField>
        </form>
      }
      flush
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error !== null && (
          <div className="px-4 pt-3 lg:px-6">
            <ErrorAlert
              message={m3ErrorMessage(error, 'Could not run that search.')}
            />
          </div>
        )}

        {isKey ? (
          <p className="px-4 py-3 text-sm text-text-muted lg:px-6">
            <TextLink to={`/w/${slug}/issues/${deferred.toUpperCase()}`}>
              Go to {deferred.toUpperCase()}
            </TextLink>
          </p>
        ) : deferred === '' ? (
          <EmptyState
            icon={<LuSearch />}
            message="Type a word to search the teams you can see."
          />
        ) : !indexable ? (
          <EmptyState message="Search needs a word of at least four letters. Shorter words are not indexed." />
        ) : isLoading ? (
          <Spinner label="Searching" />
        ) : results.length === 0 ? (
          <EmptyState message="Nothing matched that search." />
        ) : (
          <>
            <ul>
              {results.map((result) => (
                <li
                  key={result.issue_id}
                  className="flex h-row items-center border-b border-line px-4 transition-colors duration-100 hover:bg-surface lg:px-6"
                >
                  <Link
                    to={`/w/${slug}/issues/${result.key}`}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xs"
                  >
                    <span className="w-16 shrink-0 truncate font-mono text-xs text-text-faint">
                      {result.key}
                    </span>
                    <span className="truncate text-sm font-medium text-text">
                      {result.title}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {results.length >= RESULT_LIMIT && (
              <p className="px-4 py-3 text-xs text-text-faint lg:px-6">
                Showing the first {RESULT_LIMIT} matches. Narrow the term to see
                fewer, more exact ones.
              </p>
            )}
          </>
        )}
      </div>
    </WorkspaceShell>
  );
};

export default Search;
