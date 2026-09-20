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
import { LuLink2, LuX } from 'react-icons/lu';
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
import Button, { IconButton } from '../ui/button';
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
      <h3 className="text-base font-semibold">Links</h3>

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
        <p className="text-sm text-text-muted">This issue has no links.</p>
      ) : (
        <ul className="rounded-md border border-line">
          {data.map((link) => (
            <li
              key={link.link_id}
              className="flex h-row items-center gap-2.5 border-b border-line px-3 transition-colors duration-100 last:border-b-0 hover:bg-surface"
            >
              <LuLink2
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-text-faint"
              />
              <span className="w-24 shrink-0 truncate text-xs text-text-muted">
                {linkTypeLabel(link.type)}
              </span>
              <span className="shrink-0 font-mono text-xs text-text-faint">
                {link.target_key}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-text">
                {link.target_title}
              </span>
              {canEdit && (
                <IconButton
                  label={`Remove link to ${link.target_key}`}
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    void remove(link.link_id).catch(() => undefined);
                  }}
                >
                  <LuX className="h-3.5 w-3.5" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="space-y-3 rounded-md border border-line bg-surface p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              id="new-link-type"
              label="Link type"
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
              placeholder="Key or title"
              autoComplete="off"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </div>

          {candidates.length > 0 && (
            <ul className="rounded-md border border-line bg-bg">
              {candidates.map((candidate) => (
                <li
                  key={candidate.id}
                  className="border-b border-line last:border-b-0"
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start rounded-none"
                    disabled={isMutating}
                    onClick={() => {
                      void add(candidate.id)
                        .then(() => {
                          setSearch('');
                        })
                        .catch(() => undefined);
                    }}
                  >
                    <span className="font-mono text-xs text-text-faint">
                      {candidate.key}
                    </span>{' '}
                    <span className="truncate">{candidate.title}</span>
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
