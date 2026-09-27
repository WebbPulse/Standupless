/**
 * Relates this issue to another: pick how they relate, then find the other
 * issue by key or title with the list route's `q`, the only read that matches
 * either, so a person can paste a key or type part of a title.
 */

import React, { useEffect, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import { createLink, listIssues } from '../../api/issues';
import { errorMessage } from '../../lib/errors';
import { LINK_TYPES, linkTypeLabel } from '../../lib/issueDisplay';
import { activityKey, linkSearchKey, linksKey } from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import type { LinkType } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Dialog from '../ui/dialog';
import Field from '../ui/field';
import { SelectField } from '../ui/select';

/** Props for AddRelationDialog. */
export interface AddRelationDialogProps {
  workspaceId: string;
  issueId: string;
  open: boolean;
  onClose: () => void;
  /** The relation the picker starts on, as a "Mark as" command asks. */
  initialType?: LinkType;
  /**
   * Called once a link lands, so the page can reread the issue: marking it a
   * duplicate also moves it to a cancelled status on the server.
   */
  onLinked?: () => void;
}

/** How many candidates the search shows at once. */
const SEARCH_LIMIT = 8;

/** How often the search re-runs while a term is held. */
const SEARCH_POLL_MS = 30000;

/** The search field's id, focused when the dialog opens. */
const SEARCH_FIELD_ID = 'add-relation-search';

/** The form inside the dialog, mounted fresh on each open. */
const AddRelationForm: React.FC<Omit<AddRelationDialogProps, 'open'>> = ({
  workspaceId,
  issueId,
  onClose,
  initialType = 'relates_to',
  onLinked,
}) => {
  const auth = useQueryAuth();
  const [type, setType] = useState<LinkType>(initialType);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const term = search.trim();

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      document.getElementById(SEARCH_FIELD_ID)?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  const { data: found } = usePolledQuery(
    ({ signal }) =>
      listIssues(workspaceId, { q: term, limit: SEARCH_LIMIT }, signal),
    {
      intervalMs: SEARCH_POLL_MS,
      enabled: term !== '',
      queryKey: linkSearchKey(issueId, term),
      auth,
    }
  );

  const candidates =
    term === ''
      ? []
      : (found?.issues ?? []).filter((issue) => issue.id !== issueId);

  const relate = (targetId: string): void => {
    if (saving) return;
    setSaving(true);
    setFailure(null);
    createLink(workspaceId, issueId, { type, target_issue_id: targetId })
      .then(() => {
        invalidateQueries([linksKey(issueId), activityKey(issueId)]);
        onLinked?.();
        showToast('Relation added');
        onClose();
      })
      .catch((error: unknown) => {
        setFailure(error);
        setSaving(false);
      });
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <SelectField
          id="add-relation-type"
          label="Relation"
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
          id={SEARCH_FIELD_ID}
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

      {failure !== null && (
        <ErrorAlert
          message={errorMessage(failure, 'Could not add that relation.')}
        />
      )}

      {term !== '' && (
        <ul
          aria-label="Matching issues"
          className="max-h-72 overflow-y-auto rounded-md border border-line bg-bg"
        >
          {candidates.length === 0 ? (
            <li className="px-3 py-2 text-sm text-text-muted">
              {found === null ? 'Searching' : 'No matching issues'}
            </li>
          ) : (
            candidates.map((candidate) => (
              <li
                key={candidate.id}
                className="border-b border-line last:border-b-0"
              >
                <button
                  type="button"
                  disabled={saving}
                  className="flex h-row w-full items-center gap-2.5 px-3 text-left text-sm transition-colors duration-100 hover:bg-raised disabled:opacity-50"
                  onClick={() => {
                    relate(candidate.id);
                  }}
                >
                  <span className="shrink-0 font-mono text-xs text-text-faint">
                    {candidate.key}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-text">
                    {candidate.title}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
};

/** The dialog title for each starting relation. */
const TITLES: Record<LinkType, string> = {
  blocked_by: 'Mark as blocked by',
  blocks: 'Mark as blocking',
  relates_to: 'Mark as related to',
  duplicate_of: 'Mark as duplicate of',
};

/** The add relation modal. */
export const AddRelationDialog: React.FC<AddRelationDialogProps> = ({
  open,
  ...props
}) => (
  <Dialog
    open={open}
    onClose={props.onClose}
    title={
      props.initialType === undefined
        ? 'Add relation'
        : TITLES[props.initialType]
    }
    size="md"
  >
    {open && <AddRelationForm {...props} />}
  </Dialog>
);

export default AddRelationDialog;
