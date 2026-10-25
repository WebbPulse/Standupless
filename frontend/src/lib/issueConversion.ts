/**
 * Duplicate issue, Duplicate as draft and Convert to project, as the issue
 * menu, the list's context menu and the command palette share them: their
 * names, the duplicate call with its notices, the create dialog preset a
 * draft copy opens on, where each result opens and what the conversion's
 * confirmation says it will do.
 */

import { duplicateIssue, getIssue } from '../api/issues';
import type { CreateIssueOptions } from '../hooks/useCreateIssue';
import { errorMessage } from './errors';
import { issuePath, projectPath } from './paths';
import { showErrorToast, showToast } from './toast';
import type { IssueConversionRead, IssueRead } from '../types/Api';

/** The duplicate command's name, in the menus and the palette. */
export const DUPLICATE_ISSUE_LABEL = 'Duplicate issue';

/** The draft copy command's name, in the menus and the palette. */
export const DUPLICATE_AS_DRAFT_LABEL = 'Duplicate as draft';

/** The conversion command's name, in the menus, the palette and the dialog. */
export const CONVERT_TO_PROJECT_LABEL = 'Convert to project';

/** The fields the commands read from an issue, which a list row also carries. */
export type ConvertibleIssue = Pick<
  IssueRead,
  'id' | 'key' | 'title' | 'team_id' | 'progress'
>;

/** The duplicate dialog's toggle, which copies the sub-issue tree too. */
export const INCLUDE_SUB_ISSUES_LABEL = 'Include sub-issues';

/**
 * Whether Duplicate asks first: only an issue with sub-issues offers the
 * Include sub-issues toggle, and any other issue is copied at once.
 */
export const duplicateAsks = (issue: ConvertibleIssue): boolean =>
  issue.progress.total > 0;

/**
 * Files a copy of one issue, and its sub-issues when `includeSubIssues`, and
 * answers it, raising a notice either way. The caller opens the copy, since a
 * page and a list open issues differently.
 */
export const runDuplicate = async (
  workspaceId: string,
  issue: ConvertibleIssue,
  includeSubIssues = false
): Promise<IssueRead | null> => {
  try {
    const copy = await duplicateIssue(workspaceId, issue.id, includeSubIssues);
    showToast(`Duplicated ${issue.key} as ${copy.key}`);
    return copy;
  } catch (cause) {
    showErrorToast(errorMessage(cause, 'Could not duplicate that issue.'));
    return null;
  }
};

/**
 * The create dialog options a draft copy of `source` opens on: its title,
 * description, team and every property, with nothing filed and the copy kept
 * as a draft even before it is edited. Sub-issues, comments and attachments
 * are left to Duplicate issue.
 */
export const duplicateDraftOptions = (
  source: IssueRead,
  parent?: Pick<IssueRead, 'key' | 'title'> | null
): CreateIssueOptions => {
  const parentKey = parent?.key ?? source.parent_key ?? null;
  const parentTitle = parent?.title ?? source.parent_title ?? null;
  return {
    teamId: source.team_id,
    title: source.title,
    description: source.body ?? '',
    statusId: source.status_id,
    priority: source.priority,
    labelIds: [...source.label_ids],
    ...(source.estimate === null ? {} : { estimate: source.estimate }),
    ...(source.assignee_id === null ? {} : { assigneeId: source.assignee_id }),
    ...(source.project_id === null ? {} : { projectId: source.project_id }),
    ...((source.project_milestone_id ?? null) === null
      ? {}
      : { projectMilestoneId: source.project_milestone_id ?? '' }),
    ...(source.cycle_id === null ? {} : { cycleId: source.cycle_id }),
    ...(source.parent_id === null
      ? {}
      : {
          parentId: source.parent_id,
          ...(parentKey === null ? {} : { parentKey }),
          ...(parentTitle === null ? {} : { parentTitle }),
        }),
    keepAsDraft: true,
  };
};

/**
 * Reads the issue afresh, and its parent's key and title when it has one,
 * then opens the create dialog on a draft copy of it. A list row can be
 * stale, so the copy is taken from the server's current issue.
 */
export const openDuplicateDraft = async (
  workspaceId: string,
  issueId: string,
  open: (options: CreateIssueOptions) => void
): Promise<void> => {
  let source: IssueRead;
  try {
    source = await getIssue(workspaceId, issueId);
  } catch (cause) {
    showErrorToast(errorMessage(cause, 'Could not copy that issue.'));
    return;
  }
  let parent: IssueRead | null = null;
  if (source.parent_id !== null) {
    try {
      parent = await getIssue(workspaceId, source.parent_id);
    } catch {
      parent = null;
    }
  }
  open(duplicateDraftOptions(source, parent));
};

/** Where a duplicate opens, for a caller that navigates to it. */
export const duplicatePath = (slug: string, copy: IssueRead): string =>
  issuePath(slug, copy.key);

/** Where a converted issue's project opens, keeping the reader on its team. */
export const convertedPath = (
  slug: string,
  result: IssueConversionRead,
  teamKeyPrefix?: string
): string => projectPath(slug, result.project, teamKeyPrefix);

/** What the confirmation says the conversion will do. */
export const conversionSummary = (issue: ConvertibleIssue): string => {
  const children = issue.progress.total;
  const moved =
    children === 0
      ? ''
      : children === 1
        ? ' Its sub-issue moves into the project.'
        : ` Its ${String(children)} sub-issues move into the project.`;
  return `A project named "${issue.title}" is created from ${issue.key}.${moved} ${issue.key} is linked to the project and closed.`;
};
