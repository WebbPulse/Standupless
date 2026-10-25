/**
 * Duplicate issue and Convert to project, as the issue menu, the list's
 * context menu and the command palette share them: their names, the
 * duplicate call with its notices, where each result opens and what the
 * conversion's confirmation says it will do.
 */

import { duplicateIssue } from '../api/issues';
import { errorMessage } from './errors';
import { issuePath, projectPath } from './paths';
import { showErrorToast, showToast } from './toast';
import type { IssueConversionRead, IssueRead } from '../types/Api';

/** The duplicate command's name, in the menus and the palette. */
export const DUPLICATE_ISSUE_LABEL = 'Duplicate issue';

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

/** Where a duplicate opens, for a caller that navigates to it. */
export const duplicatePath = (slug: string, copy: IssueRead): string =>
  issuePath(slug, copy.key);

/** Where a converted issue's project opens, keeping the reader on its team. */
export const convertedPath = (
  slug: string,
  result: IssueConversionRead,
  teamKeyPrefix?: string
): string => projectPath(slug, result.project.project_id, teamKeyPrefix);

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
