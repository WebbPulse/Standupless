/**
 * The links on one issue. The target is picked by searching the workspace with
 * the list route's `q`, which is the only read the contract offers that matches
 * a key or a title, so a person can paste a key or type part of a title.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  createLink,
  deleteLink,
  listIssues,
  listLinks,
} from '../../api/issues';
import { errorMessage } from '../../lib/errors';
import { LINK_TYPES, linkTypeLabel } from '../../lib/issueDisplay';
import { linkSearchKey, linksKey } from '../../lib/queryKeys';
import type { LinkType } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Field from '../ui/field';
import { SelectField } from '../ui/select';

/** Props for LinksSection: which issue, and whether the caller may write. */
export interface LinksSectionProps {
  workspaceId: string;
  issueId: string;
  canEdit: boolean;
}

/** How many candidates the target search shows at once. */
const SEARCH_LIMIT = 10;

/** How often the links are re-read while the issue is open. */
const POLL_MS = 60000;

/** How often the candidate search re-runs while a term is typed. */
const SEARCH_POLL_MS = 30000;

/** Lists and edits one issue's links. */
export const LinksSection: React.FC<LinksSectionProps> = ({
  workspaceId,
  issueId,
  canEdit,
}) => {
  const auth = useQueryAuth();
  const queryKey = linksKey(issueId);
  const [type, setType] = useState<LinkType>('blocks');
  const [search, setSearch] = useState('');

  const enabled = workspaceId !== '' && issueId !== '';
  const term = search.trim();

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listLinks(workspaceId, issueId, signal),
    {
      intervalMs: POLL_MS,
      enabled,
      queryKey,
      auth,
    }
  );

  const { data: found } = usePolledQuery(
    ({ signal }) =>
      listIssues(workspaceId, { q: term, limit: SEARCH_LIMIT }, signal),
    {
      intervalMs: SEARCH_POLL_MS,
      enabled: enabled && canEdit && term !== '',
      queryKey: linkSearchKey(issueId, term),
      auth,
    }
  );

  const {
    mutate: add,
    isMutating,
    error: addError,
  } = useMutationWithRefetch(
    (targetId: string) =>
      createLink(workspaceId, issueId, { type, target_issue_id: targetId }),
    queryKey
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    (linkId: string) => deleteLink(workspaceId, issueId, linkId),
    queryKey
  );

  const candidates =
    term === ''
      ? []
      : (found?.issues ?? []).filter((issue) => issue.id !== issueId);

  return (
    <section className="space-y-3">
      <h3 className="text-base font-medium text-white">Links</h3>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the links.')}
        />
      )}
      {addError !== null && (
        <ErrorAlert
          message={errorMessage(addError, 'Could not add that link.')}
        />
      )}
      {removeError !== null && (
        <ErrorAlert
          message={errorMessage(removeError, 'Could not remove that link.')}
        />
      )}

      {isLoading || data === null ? null : data.length === 0 ? (
        <p className="text-sm text-slate-400">This issue has no links.</p>
      ) : (
        <ul className="space-y-2">
          {data.map((link) => (
            <li
              key={link.link_id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-slate-700 px-3 py-2"
            >
              <span className="text-xs text-slate-400">
                {linkTypeLabel(link.type)}
              </span>
              <span className="font-mono text-xs text-sky-400">
                {link.target_key}
              </span>
              <span className="text-sm text-slate-100">
                {link.target_title}
              </span>
              {canEdit && (
                <Button
                  variant="secondary"
                  className="ml-auto"
                  aria-label={`Remove link to ${link.target_key}`}
                  onClick={() => {
                    void remove(link.link_id).catch(() => undefined);
                  }}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="space-y-2 rounded-md border border-slate-700 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <SelectField
              id="new-link-type"
              label="Link type"
              className="w-44"
              value={type}
              onChange={(event) => {
                setType(event.target.value as LinkType);
              }}
            >
              {LINK_TYPES.map((value) => (
                <option key={value} value={value}>
                  {linkTypeLabel(value)}
                </option>
              ))}
            </SelectField>
            <Field
              id="new-link-search"
              label="Find an issue"
              type="search"
              className="w-56"
              placeholder="Key or title"
              autoComplete="off"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </div>

          {candidates.length > 0 && (
            <ul className="space-y-1">
              {candidates.map((candidate) => (
                <li key={candidate.id}>
                  <Button
                    variant="secondary"
                    disabled={isMutating}
                    onClick={() => {
                      void add(candidate.id)
                        .then(() => {
                          setSearch('');
                        })
                        .catch(() => undefined);
                    }}
                  >
                    {candidate.key} {candidate.title}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};

export default LinksSection;
