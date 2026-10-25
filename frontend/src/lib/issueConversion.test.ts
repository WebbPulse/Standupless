/**
 * The shared pieces of Duplicate issue, Duplicate as draft and Convert to
 * project: the duplicate call with its notices, the create dialog options a
 * draft copy opens on and the fresh read behind them, where each result opens, and what the conversion's
 * confirmation says it will do for an issue with none, one or several
 * sub-issues.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateIssueOptions } from '../hooks/useCreateIssue';
import type { IssueConversionRead, IssueRead } from '../types/Api';
import {
  conversionSummary,
  convertedPath,
  duplicateAsks,
  duplicateDraftOptions,
  duplicatePath,
  openDuplicateDraft,
  runDuplicate,
} from './issueConversion';
import { clearToasts, currentToasts } from './toast';

const duplicateIssue =
  vi.fn<
    (
      workspaceId: string,
      issueId: string,
      includeSubIssues?: boolean
    ) => Promise<IssueRead>
  >();

const getIssue =
  vi.fn<(workspaceId: string, issueId: string) => Promise<IssueRead>>();

vi.mock('../api/issues', () => ({
  duplicateIssue: (
    workspaceId: string,
    issueId: string,
    includeSubIssues?: boolean
  ) => duplicateIssue(workspaceId, issueId, includeSubIssues),
  getIssue: (workspaceId: string, issueId: string) =>
    getIssue(workspaceId, issueId),
}));

/** An issue in team t-1 with the given overrides. */
const issue = (id: string, overrides: Partial<IssueRead> = {}): IssueRead => ({
  id,
  workspace_id: 'ws-1',
  team_id: 't-1',
  key: `ENG-${id}`,
  number: Number(id),
  title: `Issue ${id}`,
  body: null,
  status_id: 'st-1',
  priority: 'none',
  assignee_id: null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: null,
  project_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...overrides,
});

beforeEach(() => {
  duplicateIssue.mockReset();
  getIssue.mockReset();
});

afterEach(() => {
  clearToasts();
});

describe('runDuplicate', () => {
  it('answers the copy and says which key it took', async () => {
    duplicateIssue.mockResolvedValue(issue('7', { title: 'Issue 1 (copy)' }));

    const copy = await runDuplicate('ws-1', issue('1'));

    expect(duplicateIssue).toHaveBeenCalledWith('ws-1', '1', false);
    expect(copy?.key).toBe('ENG-7');
    expect(currentToasts().map((toast) => toast.message)).toEqual([
      'Duplicated ENG-1 as ENG-7',
    ]);
  });

  it('answers null and raises a failure notice when the call is refused', async () => {
    duplicateIssue.mockRejectedValue(new Error('boom'));

    const copy = await runDuplicate('ws-1', issue('1'));

    expect(copy).toBeNull();
    expect(currentToasts().map((toast) => toast.tone)).toEqual(['error']);
  });
});

describe('duplicateAsks', () => {
  it('asks only for an issue with sub-issues', () => {
    expect(duplicateAsks(issue('1'))).toBe(false);
    expect(
      duplicateAsks(issue('1', { progress: { total: 2, completed: 0 } }))
    ).toBe(true);
  });

  it('passes the include sub-issues choice on', async () => {
    duplicateIssue.mockResolvedValue(issue('7'));

    await runDuplicate('ws-1', issue('1'), true);

    expect(duplicateIssue).toHaveBeenCalledWith('ws-1', '1', true);
  });
});

describe('paths', () => {
  it('opens a duplicate by its key and a converted issue on its project', () => {
    const result = {
      project: { project_id: 'p-1', name: 'Issue 1' },
      issue: issue('1'),
      moved_issue_ids: [],
    } as unknown as IssueConversionRead;

    expect(duplicatePath('acme', issue('7'))).toBe('/w/acme/issues/ENG-7');
    expect(convertedPath('acme', result)).toBe('/w/acme/projects/p-1');
    expect(convertedPath('acme', result, 'ENG')).toBe(
      '/w/acme/projects/p-1?team=ENG'
    );
  });
});

describe('conversionSummary', () => {
  it('names the project and leaves sub-issues out when there are none', () => {
    expect(conversionSummary(issue('1'))).toBe(
      'A project named "Issue 1" is created from ENG-1. ENG-1 is linked to the project and closed.'
    );
  });

  it('says one sub-issue moves', () => {
    const parent = issue('1', { progress: { total: 1, completed: 0 } });

    expect(conversionSummary(parent)).toContain(
      'Its sub-issue moves into the project.'
    );
  });

  it('counts several sub-issues', () => {
    const parent = issue('1', { progress: { total: 3, completed: 1 } });

    expect(conversionSummary(parent)).toContain(
      'Its 3 sub-issues move into the project.'
    );
  });
});

/** A source issue with every property a draft copy carries set. */
const fullSource = (): IssueRead =>
  issue('1', {
    title: 'Fix login',
    body: 'Steps to reproduce',
    status_id: 'st-2',
    priority: 'high',
    assignee_id: 'user-9',
    label_ids: ['lb-1', 'lb-2'],
    estimate: '3',
    project_id: 'p-1',
    project_milestone_id: 'm-1',
    cycle_id: 'c-1',
    parent_id: '5',
    progress: { total: 2, completed: 1 },
  });

describe('duplicateDraftOptions', () => {
  it('prefills every property and keeps the copy as a draft', () => {
    expect(
      duplicateDraftOptions(fullSource(), { key: 'ENG-5', title: 'Epic' })
    ).toEqual({
      teamId: 't-1',
      title: 'Fix login',
      description: 'Steps to reproduce',
      statusId: 'st-2',
      priority: 'high',
      labelIds: ['lb-1', 'lb-2'],
      estimate: '3',
      assigneeId: 'user-9',
      projectId: 'p-1',
      projectMilestoneId: 'm-1',
      cycleId: 'c-1',
      parentId: '5',
      parentKey: 'ENG-5',
      parentTitle: 'Epic',
      keepAsDraft: true,
    });
  });

  it('leaves unset properties out and never carries sub-issues', () => {
    const options = duplicateDraftOptions(issue('1'));

    expect(options).toEqual({
      teamId: 't-1',
      title: 'Issue 1',
      description: '',
      statusId: 'st-1',
      priority: 'none',
      labelIds: [],
      keepAsDraft: true,
    });
    expect(Object.keys(options)).not.toContain('subIssues');
  });
});

describe('openDuplicateDraft', () => {
  it('reads the issue and its parent afresh and opens the dialog on the copy', async () => {
    getIssue.mockImplementation((_w, id) =>
      Promise.resolve(
        id === '1' ? fullSource() : issue('5', { title: 'Login epic' })
      )
    );
    const open = vi.fn<(options: CreateIssueOptions) => void>();

    await openDuplicateDraft('ws-1', '1', open);

    expect(getIssue).toHaveBeenCalledWith('ws-1', '1');
    expect(getIssue).toHaveBeenCalledWith('ws-1', '5');
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Fix login',
        parentId: '5',
        parentKey: 'ENG-5',
        parentTitle: 'Login epic',
        keepAsDraft: true,
      })
    );
    expect(duplicateIssue).not.toHaveBeenCalled();
  });

  it('opens nothing and raises a notice when the issue cannot be read', async () => {
    getIssue.mockRejectedValue(new Error('boom'));
    const open = vi.fn<(options: CreateIssueOptions) => void>();

    await openDuplicateDraft('ws-1', '1', open);

    expect(open).not.toHaveBeenCalled();
    expect(currentToasts().map((toast) => toast.tone)).toEqual(['error']);
  });
});
