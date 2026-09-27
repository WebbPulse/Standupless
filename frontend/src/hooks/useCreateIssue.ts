/**
 * Opens the create issue dialog from anywhere inside a workspace: the `C`
 * shortcut, the sidebar's new issue button, the command palette, or a page
 * that wants to file an issue into the project or cycle it is showing.
 *
 * The workspace layout owns the one dialog, so the caller never has to load a
 * team's statuses, labels and people itself. The team is picked in this order:
 * the `teamId` passed in, the team the current route is inside, then the first
 * team the caller may write issues in.
 *
 * `projectId`, `cycleId`, `statusId`, `assigneeId` and `parentId` are held with
 * the request, exposed as {@link CreateIssueState.request}, and handed to the
 * dialog as its starting draft. A team change in the dialog drops them, since
 * each is scoped to the team it was chosen in.
 */

import { createContext, useContext } from 'react';
import type { IssueRead } from '../types/Api';

/** What a caller may preset on the dialog. */
export interface CreateIssueOptions {
  teamId?: string;
  projectId?: string;
  cycleId?: string;
  statusId?: string;
  assigneeId?: string;
  parentId?: string;
  /** The parent's key, shown in the dialog header beside `parentId`. */
  parentKey?: string;
  /** Called with the new issue after the dialog closes on success. */
  onCreated?: (issue: IssueRead) => void;
}

/** What {@link useCreateIssue} hands back. */
export interface CreateIssueState {
  /** Opens the dialog, preset with the options given. */
  open: (options?: CreateIssueOptions) => void;
  /** Closes the dialog without creating anything. */
  close: () => void;
  /** Whether the dialog is showing. */
  isOpen: boolean;
  /** Whether the caller may write issues in at least one team. */
  canCreate: boolean;
  /** The options the open dialog was asked for, with the team resolved. */
  request: (CreateIssueOptions & { teamId: string }) | null;
}

/** The dialog state the workspace layout provides, or null outside one. */
export const CreateIssueContext = createContext<CreateIssueState | null>(null);

/** A dialog that never opens, for use outside a workspace. */
const UNAVAILABLE: CreateIssueState = {
  open: () => undefined,
  close: () => undefined,
  isOpen: false,
  canCreate: false,
  request: null,
};

/** The workspace's create issue dialog. */
export const useCreateIssue = (): CreateIssueState =>
  useContext(CreateIssueContext) ?? UNAVAILABLE;

export default useCreateIssue;
