/**
 * What a drag of issues out of a list or board carries, so a drop target
 * outside the view, such as a sidebar team, project or cycle, can tell it from
 * a drag of a sidebar row and land it. The drag writes the issue keys as plain
 * text for other apps, and the issue ids under {@link ISSUE_DRAG_TYPE}, which
 * no sidebar row writes, so a target checks the type during the drag, when a
 * browser hides the data itself.
 *
 * A browser hands a drop only strings, so the issues themselves and the view's
 * write are held here for the length of the drag, cleared when it ends.
 */

import type { QueryKey } from '@webbpulse/api-client/react';
import type { OrderedIssueRead } from '../api/issues';
import type { IssueWrite } from '../hooks/useOptimisticIssues';

/** The media type an issue drag writes its issue ids under. */
export const ISSUE_DRAG_TYPE = 'application/x-standupless-issues';

/** The issues a drag holds, and how the view they came from writes them. */
export interface IssueDragSource {
  /** The dragged issues, the whole selection when the drag started on one of it. */
  issues: readonly OrderedIssueRead[];
  /** Whether the viewer may write one issue. */
  canEdit: (issue: OrderedIssueRead) => boolean;
  /** The view's write, which shows the change at once and records one undo. */
  update: IssueWrite;
  /** The view's own read, re-read after a move it cannot lay over. */
  queryKey?: QueryKey | undefined;
}

let active: IssueDragSource | null = null;

/** The part of a drag event's transfer an issue drag reads and writes. */
type Transfer = Partial<Pick<DataTransfer, 'setData' | 'types'>>;

/** Writes an issue drag's payload and holds its issues until the drag ends. */
export const startIssueDrag = (
  dataTransfer: Transfer | null,
  source: IssueDragSource
): void => {
  active = source;
  if (typeof dataTransfer?.setData !== 'function') return;
  dataTransfer.setData(
    'text/plain',
    source.issues.map((issue) => issue.key).join('\n')
  );
  dataTransfer.setData(
    ISSUE_DRAG_TYPE,
    JSON.stringify(source.issues.map((issue) => issue.id))
  );
};

/** Forgets the issues of a drag that ended. */
export const endIssueDrag = (): void => {
  active = null;
};

/** The issue drag in progress, or null. */
export const activeIssueDrag = (): IssueDragSource | null => active;

/**
 * Whether a drag event carries issues from a view in this window: one is in
 * progress and the transfer names the issue type. A transfer that lists no
 * types, as a test double may, is read by the drag in progress alone.
 */
export const carriesIssues = (dataTransfer: Transfer | null): boolean => {
  if (active === null) return false;
  const types = dataTransfer?.types;
  return types === undefined || Array.from(types).includes(ISSUE_DRAG_TYPE);
};
