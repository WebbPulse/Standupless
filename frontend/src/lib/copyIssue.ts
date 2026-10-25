/**
 * Copying an issue's ID, address or Markdown, shared by the list, the issue
 * page and the command palette so the keys, the wording and the toasts agree
 * everywhere, as they do in Linear.
 *
 * Copying a git branch name also starts the issue when the person's workflow
 * preferences ask for it: a backlog or unstarted issue moves to its team's
 * first started status and, if unassigned, is assigned to them, in one write
 * the calling surface makes so its own undo notice covers it.
 */

import type {
  CycleRead,
  IssueRead,
  LabelRead,
  ProjectRead,
  StatusCategory,
  StatusRead,
} from '../types/Api';
import { gitBranchName } from './gitBranch';
import { PRIORITY_LABELS } from './issueDisplay';
import { personLabel, type Assignable } from './issuePeople';
import { issuePath } from './paths';
import { readPreferences, type InterfacePreferences } from './preferences';
import { sortStatuses } from './propertyOptions';
import { showErrorToast, showToast } from './toast';

/** The keys that copy the issue in focus's ID. */
export const COPY_ISSUE_ID_KEYS = 'mod+.';

/** The keys that copy the issue in focus's address. */
export const COPY_ISSUE_URL_KEYS = 'mod+shift+,';

/** The keys that copy the issue in focus's git branch name. */
export const COPY_BRANCH_KEYS = 'mod+shift+.';

/** The command that copies the issue in focus as Markdown, which has no keys. */
export const COPY_ISSUE_MARKDOWN_LABEL = 'Copy issue as Markdown';

/** The full address of an issue in this workspace. */
export const issueUrl = (slug: string, key: string): string =>
  `${globalThis.location.origin}${issuePath(slug, key)}`;

/**
 * Copies `text` and confirms it with `done`, then runs `then`, or says the
 * clipboard refused.
 */
export const copyText = (
  text: string,
  done: string,
  then?: () => void
): void => {
  const clipboard = globalThis.navigator.clipboard as Clipboard | undefined;
  if (clipboard === undefined) {
    showErrorToast('Could not copy to the clipboard.');
    return;
  }
  void clipboard
    .writeText(text)
    .then(() => {
      showToast(done);
      then?.();
    })
    .catch(() => {
      showErrorToast('Could not copy to the clipboard.');
    });
};

/** The status categories an issue may be started from by copying its branch. */
const NOT_STARTED: ReadonlySet<StatusCategory> = new Set([
  'backlog',
  'unstarted',
]);

/** The workflow preferences copying a branch reads. */
export type BranchWorkflow = Pick<
  InterfacePreferences,
  'branchCopyStarts' | 'branchCopyAssigns'
>;

/** The change copying a branch makes, which both the single issue and the list writes take. */
export interface BranchPatch {
  status_id?: string;
  assignee_id?: string;
}

/** The issue fields that decide what copying its branch changes. */
export type BranchIssue = Pick<IssueRead, 'status_id' | 'assignee_id'> &
  Partial<Pick<IssueRead, 'in_triage'>>;

/**
 * The single patch copying an issue's branch makes, or null when there is
 * nothing to change: the issue is already started, done or waiting in
 * triage, both switches are off, or neither switch has anything to do.
 * `statuses` are the issue's own team's.
 */
export const branchStartPatch = (
  issue: BranchIssue,
  statuses: readonly StatusRead[],
  currentUserId: string,
  workflow: BranchWorkflow = readPreferences()
): BranchPatch | null => {
  if (issue.in_triage === true) return null;
  const status = statuses.find((item) => item.id === issue.status_id);
  if (status === undefined || !NOT_STARTED.has(status.category)) return null;
  const patch: BranchPatch = {};
  if (workflow.branchCopyStarts) {
    const started = sortStatuses([...statuses]).find(
      (item) => item.category === 'started' && item.hidden !== true
    );
    if (started !== undefined) patch.status_id = started.id;
  }
  if (
    workflow.branchCopyAssigns &&
    currentUserId !== '' &&
    (issue.assignee_id ?? null) === null
  ) {
    patch.assignee_id = currentUserId;
  }
  return Object.keys(patch).length === 0 ? null : patch;
};

/** What copying a branch needs to start the issue, from a surface that may edit it. */
export interface BranchStart {
  issue: BranchIssue;
  /** The issue's team's statuses. */
  statuses: readonly StatusRead[];
  /** The signed in person, assigned when the issue has nobody. */
  currentUserId: string;
  /** Writes the patch through the surface's own update, which records the undo. */
  apply: (patch: BranchPatch) => void;
}

/**
 * Copies the git branch name for an issue and names it in the toast. With
 * `start`, a landed copy also applies the workflow preferences' patch, if any.
 */
export const copyBranchName = (
  key: string,
  title: string,
  start?: BranchStart
): void => {
  const branch = gitBranchName(key, title);
  copyText(branch, `Copied ${branch}`, () => {
    if (start === undefined) return;
    const patch = branchStartPatch(
      start.issue,
      start.statuses,
      start.currentUserId
    );
    if (patch !== null) start.apply(patch);
  });
};

/** The lists an issue's ids are named from when it is copied as Markdown. */
export interface IssueMarkdownContext {
  statuses: readonly Pick<StatusRead, 'id' | 'name'>[];
  labels: readonly Pick<LabelRead, 'id' | 'name'>[];
  people: readonly Assignable[];
  projects: readonly Pick<ProjectRead, 'project_id' | 'name'>[];
  cycles: readonly Pick<CycleRead, 'cycle_id' | 'name' | 'number'>[];
}

/** The issue fields its Markdown copy reads. */
export type MarkdownIssue = Pick<
  IssueRead,
  | 'key'
  | 'title'
  | 'body'
  | 'status_id'
  | 'priority'
  | 'assignee_id'
  | 'label_ids'
  | 'project_id'
  | 'cycle_id'
>;

/** Escapes the characters that would end a Markdown link's text early. */
const linkText = (text: string): string => text.replace(/([\\[\]])/g, '\\$1');

/** How a cycle reads: its name, or its number when it has none. */
const cycleName = (
  cycle: Pick<CycleRead, 'name' | 'number'>
): string | undefined => {
  const name = cycle.name.trim();
  if (name !== '') return name;
  return typeof cycle.number === 'number'
    ? `Cycle ${String(cycle.number)}`
    : undefined;
};

/**
 * The issue as Markdown: a `# KEY Title` heading linked to `url`, a line of
 * the properties that are set (status, priority, assignee, labels, project,
 * cycle), then the description as stored. The same issue always gives the
 * same text.
 */
export const issueMarkdown = (
  issue: MarkdownIssue,
  url: string,
  context: IssueMarkdownContext
): string => {
  const properties: string[] = [];
  const status = context.statuses.find((item) => item.id === issue.status_id);
  if (status !== undefined) properties.push(`**Status:** ${status.name}`);
  if (issue.priority !== 'none') {
    properties.push(`**Priority:** ${PRIORITY_LABELS[issue.priority]}`);
  }
  if (issue.assignee_id !== null) {
    const person = context.people.find(
      (item) => item.user_id === issue.assignee_id
    );
    if (person !== undefined) {
      properties.push(`**Assignee:** ${personLabel(person)}`);
    }
  }
  const labels = issue.label_ids.flatMap((id) => {
    const label = context.labels.find((item) => item.id === id);
    return label === undefined ? [] : [label.name];
  });
  if (labels.length > 0) properties.push(`**Labels:** ${labels.join(', ')}`);
  if (issue.project_id !== null) {
    const project = context.projects.find(
      (item) => item.project_id === issue.project_id
    );
    if (project !== undefined) properties.push(`**Project:** ${project.name}`);
  }
  if (issue.cycle_id !== null) {
    const cycle = context.cycles.find(
      (item) => item.cycle_id === issue.cycle_id
    );
    const name = cycle === undefined ? undefined : cycleName(cycle);
    if (name !== undefined) properties.push(`**Cycle:** ${name}`);
  }
  const parts = [`# [${linkText(`${issue.key} ${issue.title}`)}](${url})`];
  if (properties.length > 0) parts.push(properties.join(' · '));
  const body = issue.body ?? '';
  if (body.trim() !== '') parts.push(body.replace(/\s+$/, ''));
  return `${parts.join('\n\n')}\n`;
};

/** Copies the issue as Markdown and confirms it as the other copies do. */
export const copyIssueMarkdown = (
  issue: MarkdownIssue,
  url: string,
  context: IssueMarkdownContext
): void => {
  copyText(issueMarkdown(issue, url, context), 'Issue copied as Markdown');
};
