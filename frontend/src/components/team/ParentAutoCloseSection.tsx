/**
 * A team's parent and sub-issue auto-close: whether a parent closes once its
 * last sub-issue does, and whether open sub-issues follow a parent that closes.
 *
 * Linear's two workflow switches. Each saves as soon as it is flipped, like the
 * auto-close section beside it, and both are off until a team admin turns them on.
 */

import React, { useId } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
  type QueryKey,
} from '@webbpulse/api-client/react';
import {
  getParentAutoCloseSettings,
  updateParentAutoCloseSettings,
} from '../../api/teams';
import type { ParentAutoCloseSettingsUpdate } from '../../types/Api';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { showToast } from '../../lib/toast';
import { ErrorAlert } from '../ui/alert';
import Spinner from '../ui/spinner';

/** Props for ParentAutoCloseSection: which team, and whether the caller may edit. */
export interface ParentAutoCloseSectionProps {
  workspaceId: string;
  teamId: string;
  /** Whether the caller administers the team. */
  canEdit: boolean;
}

/** How often the settings are re-read while the settings tab is open. */
const POLL_MS = 60000;

/** Props for the on and off switch a settings row ends in. */
interface ToggleProps {
  id: string;
  checked: boolean;
  disabled: boolean;
  labelledBy: string;
  onChange: (checked: boolean) => void;
}

/** An on and off switch, announced as a switch. */
const Toggle: React.FC<ToggleProps> = ({
  id,
  checked,
  disabled,
  labelledBy,
  onChange,
}) => (
  <button
    id={id}
    type="button"
    role="switch"
    aria-checked={checked}
    aria-labelledby={labelledBy}
    disabled={disabled}
    onClick={() => {
      onChange(!checked);
    }}
    className={cn(
      'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-transparent transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60',
      checked
        ? 'bg-accent enabled:hover:bg-accent-strong'
        : 'bg-line-strong enabled:hover:bg-text-faint',
      'enabled:active:brightness-90'
    )}
  >
    <span
      aria-hidden="true"
      className={cn(
        'inline-block h-3 w-3 rounded-full bg-bg shadow-sm transition-transform duration-100',
        checked ? 'translate-x-3' : 'translate-x-0'
      )}
    />
  </button>
);

/** Props for one labelled settings row. */
interface RowProps {
  labelId: string;
  controlId: string;
  label: string;
  hint: string;
  children: React.ReactNode;
}

/** One setting: its name and a line on what it does, with the control beside them. */
const Row: React.FC<RowProps> = ({
  labelId,
  controlId,
  label,
  hint,
  children,
}) => (
  <li className="flex min-h-row items-center justify-between gap-4 px-3 py-2">
    <div className="min-w-0">
      <label
        id={labelId}
        htmlFor={controlId}
        className="block text-sm font-medium text-text"
      >
        {label}
      </label>
      <p className="text-xs text-text-muted">{hint}</p>
    </div>
    <div className="shrink-0">{children}</div>
  </li>
);

/** Shows and edits whether a team closes parents and sub-issues together. */
export const ParentAutoCloseSection: React.FC<ParentAutoCloseSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
}) => {
  const auth = useQueryAuth();
  const parentId = useId();
  const parentLabelId = useId();
  const childrenId = useId();
  const childrenLabelId = useId();
  const queryKey: QueryKey = [
    'parent-auto-close-settings',
    workspaceId,
    teamId,
  ];

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => getParentAutoCloseSettings(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const {
    mutate: save,
    error: saveError,
    isMutating: saving,
  } = useMutationWithRefetch(
    (body: ParentAutoCloseSettingsUpdate) =>
      updateParentAutoCloseSettings(workspaceId, teamId, body),
    [queryKey]
  );

  const submit = async (
    body: ParentAutoCloseSettingsUpdate,
    message: string
  ): Promise<void> => {
    if (!canEdit) return;
    try {
      await save(body);
      await refetch();
      showToast(message);
    } catch {
      return;
    }
  };

  const closeParent = data?.close_parent ?? false;
  const closeSubIssues = data?.close_sub_issues ?? false;

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Parent and sub-issues</h3>
        <p className="text-sm text-text-muted">
          Keep a parent issue and its sub-issues in step as they are completed
          or canceled.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(
            error,
            'Could not load the parent and sub-issue settings.'
          )}
        />
      )}
      {saveError !== null && (
        <ErrorAlert
          message={errorMessage(
            saveError,
            'Could not save the parent and sub-issue settings.'
          )}
        />
      )}

      {isLoading && data === null ? (
        <Spinner label="Loading the parent and sub-issue settings" />
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          <Row
            labelId={parentLabelId}
            controlId={parentId}
            label="Auto-close parent issues"
            hint="Completes a parent issue once all of its sub-issues are completed or canceled."
          >
            <Toggle
              id={parentId}
              labelledBy={parentLabelId}
              checked={closeParent}
              disabled={!canEdit || saving}
              onChange={(next) => {
                void submit(
                  { close_parent: next },
                  next
                    ? 'Parent issues now close with their sub-issues.'
                    : 'Parent auto-close turned off.'
                );
              }}
            />
          </Row>
          <Row
            labelId={childrenLabelId}
            controlId={childrenId}
            label="Auto-close sub-issues"
            hint="Completes or cancels open sub-issues when their parent issue is completed or canceled."
          >
            <Toggle
              id={childrenId}
              labelledBy={childrenLabelId}
              checked={closeSubIssues}
              disabled={!canEdit || saving}
              onChange={(next) => {
                void submit(
                  { close_sub_issues: next },
                  next
                    ? 'Sub-issues now close with their parent.'
                    : 'Sub-issue auto-close turned off.'
                );
              }}
            />
          </Row>
        </ul>
      )}
    </section>
  );
};

export default ParentAutoCloseSection;
