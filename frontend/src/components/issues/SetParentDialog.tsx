/**
 * The parent picker Ctrl+Shift+P opens: a search over the top level issues of
 * the targets' team, read from the server as the filter text changes, with a
 * "Remove parent" row while any target sits under a parent. Sub-issues share
 * their parent's team and nest one level deep, so it offers nothing to pick
 * when the targets span teams or one of them already has sub-issues, and it
 * never offers a target as its own parent.
 */

import React, { useMemo, useState } from 'react';
import { LuCornerUpLeft, LuX } from 'react-icons/lu';
import { useParentSearch } from '../../hooks/useParentSearch';
import type { IssueRead } from '../../types/Api';
import { Combobox, type ComboboxOption } from '../ui/combobox';
import Dialog from '../ui/dialog';

/** The keys that open the parent picker. */
export const SET_PARENT_KEYS = 'mod+shift+p';

/** The value of the row that detaches the targets from their parent. */
const REMOVE = '\u0000remove';

/** The fields of an issue the picker reads. */
export type ParentTarget = Pick<
  IssueRead,
  'id' | 'key' | 'title' | 'workspace_id' | 'team_id' | 'parent_id' | 'progress'
>;

/** Props for SetParentDialog. */
export interface SetParentDialogProps {
  /** The issues the picked parent is written to, one or a selection. */
  issues: readonly ParentTarget[];
  /** Writes the picked parent's id, or null to remove the parent. */
  onPick: (parentId: string | null) => void;
  onClose: () => void;
}

/** Why the targets cannot take a new parent, or null when they can. */
export const parentBlocker = (
  issues: readonly ParentTarget[]
): string | null => {
  if (new Set(issues.map((issue) => issue.team_id)).size > 1) {
    return 'Sub-issues share their parent’s team. Pick issues from one team.';
  }
  const nesting = issues.find((issue) => issue.progress.total > 0);
  if (nesting !== undefined) {
    return `${nesting.key} has sub-issues, so it cannot sit under another issue.`;
  }
  return null;
};

/** The dialog. */
export const SetParentDialog: React.FC<SetParentDialogProps> = ({
  issues,
  onPick,
  onClose,
}) => {
  const [query, setQuery] = useState('');
  const blocker = parentBlocker(issues);
  const workspaceId = issues[0]?.workspace_id ?? '';
  const teamId = issues[0]?.team_id ?? '';
  const found = useParentSearch(workspaceId, teamId, query, blocker === null);

  const targetIds = useMemo(
    () => new Set(issues.map((issue) => issue.id)),
    [issues]
  );
  const parentIds = [...new Set(issues.map((issue) => issue.parent_id))];
  const shared = parentIds.length === 1 ? (parentIds[0] ?? null) : null;
  const anyParent = issues.some((issue) => issue.parent_id !== null);

  const options: ComboboxOption[] = [];
  if (anyParent) {
    options.push({
      value: REMOVE,
      label: 'Remove parent',
      icon: <LuX aria-hidden="true" className="h-3.5 w-3.5 text-text-faint" />,
    });
  }
  if (blocker === null) {
    for (const candidate of found ?? []) {
      if (targetIds.has(candidate.id)) continue;
      options.push({
        value: candidate.id,
        label: candidate.title,
        detail: candidate.key,
        keywords: [candidate.key],
        icon: (
          <LuCornerUpLeft
            aria-hidden="true"
            className="h-3.5 w-3.5 text-text-faint"
          />
        ),
      });
    }
  }

  const subject =
    issues.length === 1
      ? (issues[0]?.key ?? '')
      : `${String(issues.length)} issues`;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Set parent issue, ${subject}`}
      hideTitle
      size="sm"
    >
      <div className="-mx-4 -mt-8 -mb-4">
        <p className="border-b border-line px-3 pt-2.5 pb-2 text-xs text-text-muted">
          <span className="rounded-sm bg-raised px-1.5 py-0.5 font-mono text-2xs text-text">
            {subject}
          </span>
        </p>
        <Combobox
          label="Set parent issue"
          placeholder="Set parent issue..."
          options={options}
          selected={shared === null ? [] : [shared]}
          emptyMessage={
            blocker ??
            (found === null
              ? 'Searching...'
              : 'No top level issue in this team matches.')
          }
          onQueryChange={setQuery}
          onSelect={(value) => {
            onPick(value === REMOVE ? null : value);
            onClose();
          }}
        />
        {blocker !== null && anyParent && (
          <p className="border-t border-line px-3 py-2 text-xs text-text-muted">
            {blocker}
          </p>
        )}
      </div>
    </Dialog>
  );
};

export default SetParentDialog;
