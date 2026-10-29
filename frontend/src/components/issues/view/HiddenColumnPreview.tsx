/**
 * The preview a hidden board column opens from the rail: its issues as
 * compact rows of key, title and assignee, so the viewer can check a column
 * such as Done without putting it back on the board. A row opens its issue,
 * Space on a row opens it in the peek instead, and Show column brings the
 * column back. The arrow keys and j or k walk the rows, and the first row
 * takes the focus when the preview opens.
 */

import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { LuCircleDashed, LuEye } from 'react-icons/lu';
import type { OrderedIssueRead } from '../../../api/issues';
import { personAvatar, personLabel } from '../../../lib/issuePeople';
import type { IssueGroup } from '../../../lib/issueView';
import { issuePath } from '../../../lib/paths';
import Avatar from '../../ui/avatar';
import { useIssueViewEnv } from './IssueViewContext';

/** Props for HiddenColumnPreview. */
export interface HiddenColumnPreviewProps {
  column: IssueGroup;
  /** Brings the column back onto the board. */
  onShow: () => void;
  /** Closes the preview. */
  onClose: () => void;
}

/** How far each walking key moves through the rows. */
const STEPS: Readonly<Record<string, number>> = {
  ArrowDown: 1,
  j: 1,
  ArrowUp: -1,
  k: -1,
};

/** What the walking keys move between: the rows, then Show column. */
const STOPS = '[data-preview-stop]';

/** One issue's assignee as a small avatar, or a dashed circle for nobody. */
const PreviewAssignee: React.FC<{ issue: OrderedIssueRead }> = ({ issue }) => {
  const { forTeam, context } = useIssueViewEnv();
  if (issue.assignee_id === null) {
    return (
      <LuCircleDashed
        aria-label="No assignee"
        className="h-3.5 w-3.5 shrink-0 text-text-faint"
      />
    );
  }
  const own = forTeam(issue.team_id).people;
  const people = own.length > 0 ? own : context.people;
  const person = people.find((item) => item.user_id === issue.assignee_id);
  return (
    <Avatar name={personLabel(person)} src={personAvatar(person)} size="xs" />
  );
};

/** The issue list and the Show column action of one hidden column. */
export const HiddenColumnPreview: React.FC<HiddenColumnPreviewProps> = ({
  column,
  onShow,
  onClose,
}) => {
  const env = useIssueViewEnv();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    root.current?.querySelector<HTMLElement>(STOPS)?.focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const step = STEPS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const stops = Array.from(
      root.current?.querySelectorAll<HTMLElement>(STOPS) ?? []
    );
    if (stops.length === 0) return;
    const at = stops.indexOf(document.activeElement as HTMLElement);
    const next =
      at === -1
        ? step > 0
          ? 0
          : stops.length - 1
        : Math.min(stops.length - 1, Math.max(0, at + step));
    stops[next]?.focus();
  };

  return (
    <div ref={root} onKeyDown={onKeyDown} className="flex flex-col">
      <p className="flex h-8 items-center gap-2 border-b border-line px-3 text-xs font-medium text-text-muted">
        <span className="min-w-0 flex-1 truncate">{column.label}</span>
        <span className="tabular-nums">{column.issues.length}</span>
      </p>
      {column.issues.length === 0 ? (
        <p className="px-3 py-3 text-sm text-text-faint">No issues</p>
      ) : (
        <ul
          aria-label={`${column.label} issues`}
          className="flex max-h-80 flex-col overflow-y-auto p-1"
        >
          {column.issues.map((issue) => (
            <li key={issue.id}>
              <Link
                to={issuePath(env.slug, issue.key)}
                data-preview-stop=""
                onClick={() => {
                  env.onOpen?.();
                }}
                onKeyDown={(event) => {
                  if (event.key !== ' ') return;
                  event.preventDefault();
                  event.stopPropagation();
                  env.peek(issue);
                  onClose();
                }}
                className="flex h-8 items-center gap-2 rounded-sm px-2 text-sm text-text hover:bg-raised focus-visible:bg-raised focus-visible:outline-none pointer-coarse:h-11"
              >
                <span className="w-16 shrink-0 truncate font-mono text-2xs text-text-faint">
                  {issue.key}
                </span>
                <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                <PreviewAssignee issue={issue} />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-line p-1">
        <button
          type="button"
          data-preview-stop=""
          onClick={() => {
            onShow();
            onClose();
          }}
          className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm text-text-muted hover:bg-raised hover:text-text focus-visible:bg-raised focus-visible:outline-none pointer-coarse:h-11"
        >
          <LuEye aria-hidden="true" className="h-3.5 w-3.5" />
          Show column
        </button>
      </div>
    </div>
  );
};

export default HiddenColumnPreview;
