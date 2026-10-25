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
 * each is scoped to the team it was chosen in. `priority` starts the draft on a
 * priority, such as a parent's, and survives a team change. `templateId` names the template
 * the draft starts from in place of the team's default. `title` and
 * `description` start the draft on text, such as a selection, and
 * `relatedIssueId` relates the new issue to the one the text came from.
 * `expanded` opens the dialog already expanded, as `V` does, and `showDrafts`
 * opens it on its Drafts list. `labelIds`, `estimate`, `projectMilestoneId`
 * and `parentTitle` complete a copy of another issue, and `keepAsDraft`, as
 * Duplicate as draft sets it, keeps the prefilled text as a draft on close
 * even before it is edited, without the team's default template or the
 * assign to self preference. `links` attaches web links to the issue once it
 * is created, as a prefilled `/new` link carries them.
 *
 * {@link CreateIssueState.hasDraft} says whether the viewer has any new issue
 * draft saved in this workspace, so the new issue button can show that the
 * Drafts list holds something to resume.
 */

import { createContext, useContext } from 'react';
import type { IssuePriority, IssueRead } from '../types/Api';

/** The keys that open the template picker, Alt+C (Option+C) as in Linear. */
export const CREATE_FROM_TEMPLATE_KEYS = 'alt+c';

/** The key that opens the dialog already expanded, `V` as in Linear. */
export const CREATE_FULLSCREEN_KEYS = 'v';

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
  /** The parent's title, kept with the draft beside `parentKey`. */
  parentTitle?: string;
  /** The labels the draft starts with. */
  labelIds?: string[];
  /** The estimate the draft starts on. */
  estimate?: string;
  /** The project milestone the draft starts in, beside `projectId`. */
  projectMilestoneId?: string;
  /** Whether the prefilled draft is kept on close before any edit, as a copy is. */
  keepAsDraft?: boolean;
  /** The priority the draft starts on, such as a parent's for a sub-issue. */
  priority?: IssuePriority;
  /** A template the draft starts from, in place of the team's default. */
  templateId?: string;
  /** The title the draft starts with, such as a selected line of text. */
  title?: string;
  /** The description Markdown the draft starts with, beside `title`. */
  description?: string;
  /** An issue the new one is filed as related to. */
  relatedIssueId?: string;
  /** Web links attached to the issue once it is created. */
  links?: { url: string; title?: string }[];
  /** Whether the dialog opens expanded, as `V` opens it. */
  expanded?: boolean;
  /** Whether the dialog opens on its Drafts list, as the command palette does. */
  showDrafts?: boolean;
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
  /** Whether the viewer has a saved draft to resume. */
  hasDraft?: boolean;
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
  hasDraft: false,
};

/** The workspace's create issue dialog. */
export const useCreateIssue = (): CreateIssueState =>
  useContext(CreateIssueContext) ?? UNAVAILABLE;

export default useCreateIssue;
