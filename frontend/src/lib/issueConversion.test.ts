/**
 * The shared pieces of Duplicate issue and Convert to project: the duplicate
 * call with its notices, where each result opens, and what the conversion's
 * confirmation says it will do for an issue with none, one or several
 * sub-issues.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueConversionRead, IssueRead } from '../types/Api';
import {
  conversionSummary,
  convertedPath,
  duplicatePath,
  runDuplicate,
} from './issueConversion';
import { clearToasts, currentToasts } from './toast';

const duplicateIssue =
  vi.fn<(workspaceId: string, issueId: string) => Promise<IssueRead>>();

vi.mock('../api/issues', () => ({
  duplicateIssue: (workspaceId: string, issueId: string) =>
    duplicateIssue(workspaceId, issueId),
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
});

afterEach(() => {
  clearToasts();
});

describe('runDuplicate', () => {
  it('answers the copy and says which key it took', async () => {
    duplicateIssue.mockResolvedValue(issue('7', { title: 'Issue 1 (copy)' }));

    const copy = await runDuplicate('ws-1', issue('1'));

    expect(duplicateIssue).toHaveBeenCalledWith('ws-1', '1');
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
