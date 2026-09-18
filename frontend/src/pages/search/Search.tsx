/**
 * Search across the projects a person can see. The result set is capped rather
 * than paged, because the contract does not mint a cursor over an intersection
 * of posting lists, so this page offers a narrower term instead of a next page.
 *
 * An exact issue key short circuits to that issue, since typing a key is the
 * most common search and the index is not the right answer for it.
 */

import React, { useCallback, useDeferredValue, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { search } from '../../api/views';
import { listProjects } from '../../api/projects';
import { ErrorAlert } from '../../components/ui/alert';
import Field from '../../components/ui/field';
import { SelectField } from '../../components/ui/select';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { m3ErrorMessage } from '../../lib/errors';
import { projectsKey, searchKey } from '../../lib/queryKeys';
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

/** How often the project list re-reads. */
const PROJECTS_POLL_MS = 60000;

/** Searches issues by title and body across the visible projects. */
export const Search: React.FC = () => {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const auth = useQueryAuth();
  const [term, setTerm] = useState('');
  const [projectId, setProjectId] = useState('');

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

  const { data: projects } = usePolledQuery(
    ({ signal }) => listProjects(workspaceId, signal),
    {
      intervalMs: PROJECTS_POLL_MS,
      enabled: workspaceId !== '',
      queryKey: projectsKey(workspaceId),
      auth,
    }
  );

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) =>
      search(
        workspaceId,
        deferred,
        {
          ...(projectId === '' ? {} : { project_id: projectId }),
          limit: RESULT_LIMIT,
        },
        signal
      ),
    {
      intervalMs: POLL_MS,
      enabled,
      queryKey: searchKey(workspaceId, deferred, projectId),
      auth,
    }
  );

  const goToKey = useCallback(() => {
    if (!isKey) return;
    void navigate(`/w/${slug}/issues/${deferred.toUpperCase()}`);
  }, [isKey, navigate, slug, deferred]);

  const results = data ?? [];

  return (
    <WorkspaceShell>
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-white">Search</h2>

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            goToKey();
          }}
        >
          <Field
            id="search-term"
            label="Find issues"
            className="w-72"
            placeholder="Words from a title or body, or an issue key"
            value={term}
            autoFocus
            onChange={(event) => {
              setTerm(event.target.value);
            }}
          />
          <SelectField
            id="search-project"
            label="Project"
            className="w-56"
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
            }}
          >
            <option value="">Every project</option>
            {(projects ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </SelectField>
        </form>

        {error !== null && (
          <ErrorAlert
            message={m3ErrorMessage(error, 'Could not run that search.')}
          />
        )}

        {isKey ? (
          <p className="text-sm text-slate-400">
            <Link
              to={`/w/${slug}/issues/${deferred.toUpperCase()}`}
              className="text-sky-400 hover:text-sky-300"
            >
              Go to {deferred.toUpperCase()}
            </Link>
          </p>
        ) : deferred === '' ? (
          <p className="text-sm text-slate-400">
            Type a word to search the projects you can see.
          </p>
        ) : !indexable ? (
          <p className="text-sm text-slate-400">
            Search needs a word of at least four letters. Shorter words are not
            indexed.
          </p>
        ) : isLoading ? (
          <Spinner label="Searching" />
        ) : results.length === 0 ? (
          <p className="text-sm text-slate-400">Nothing matched that search.</p>
        ) : (
          <>
            <ul className="space-y-2">
              {results.map((result) => (
                <li
                  key={result.issue_id}
                  className="rounded-md border border-slate-700 p-3"
                >
                  <Link
                    to={`/w/${slug}/issues/${result.key}`}
                    className="block text-sm text-slate-100 hover:text-white"
                  >
                    <span className="font-mono text-xs text-sky-400">
                      {result.key}
                    </span>{' '}
                    {result.title}
                  </Link>
                </li>
              ))}
            </ul>
            {results.length >= RESULT_LIMIT && (
              <p className="text-xs text-slate-500">
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
