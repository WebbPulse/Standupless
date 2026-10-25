/**
 * What an undo writes: the difference between an issue before and after a
 * change, sent through the single issue route or grouped on the bulk route.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueBulkUpdate } from '../api/issues';
import type { IssueRead, IssueUpdate } from '../types/Api';
import {
  describeChange,
  patchedIssue,
  recordDelete,
  recordMove,
  recordPatch,
  revertBetween,
  writeReverts,
} from './issueUndo';
import { TRIAGE_STATUS_ID } from './triageStatus';
import { clearUndo, undoLast } from './undo';

const updateIssue =
  vi.fn<
    (
      workspaceId: string,
      issueId: string,
      body: IssueUpdate
    ) => Promise<IssueRead>
  >();
const bulkUpdateIssues =
  vi.fn<
    (
      workspaceId: string,
      body: IssueBulkUpdate
    ) => Promise<{ issues: IssueRead[]; skipped: string[] }>
  >();
const restoreIssue =
  vi.fn<(workspaceId: string, issueId: string) => Promise<IssueRead>>();
const moveIssue =
  vi.fn<
    (workspaceId: string, issueId: string, teamId: string) => Promise<IssueRead>
  >();

vi.mock('../api/issues', async () => {
  const actual =
    await vi.importActual<typeof import('../api/issues')>('../api/issues');
  return {
    ...actual,
    updateIssue: (workspaceId: string, issueId: string, body: IssueUpdate) =>
      updateIssue(workspaceId, issueId, body),
    bulkUpdateIssues: (workspaceId: string, body: IssueBulkUpdate) =>
      bulkUpdateIssues(workspaceId, body),
    moveIssue: (workspaceId: string, issueId: string, teamId: string) =>
      moveIssue(workspaceId, issueId, teamId),
    restoreIssue: (workspaceId: string, issueId: string) =>
      restoreIssue(workspaceId, issueId),
  };
});

/** An issue with the given id over a plain default. */
const issue = (id: string, fields: Partial<IssueRead> = {}): IssueRead => ({
  id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${id}`,
  number: 1,
  title: id,
  body: null,
  status_id: 'st-todo',
  priority: 'medium',
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
  ...fields,
});

beforeEach(() => {
  clearUndo();
  updateIssue.mockReset();
  bulkUpdateIssues.mockReset();
  moveIssue.mockReset();
  restoreIssue.mockReset();
  restoreIssue.mockImplementation((_ws, id) => Promise.resolve(issue(id)));
  updateIssue.mockImplementation((_ws, id) => Promise.resolve(issue(id)));
  bulkUpdateIssues.mockImplementation((_ws, body) =>
    Promise.resolve({
      issues: body.issue_ids.map((id) => issue(id)),
      skipped: [],
    })
  );
});

describe('revertBetween', () => {
  it('answers null when nothing an undo covers moved', () => {
    expect(
      revertBetween(issue('a'), issue('a', { title: 'renamed' }))
    ).toBeNull();
  });

  it('puts back plain fields, nulls included', () => {
    const revert = revertBetween(
      issue('a', { priority: 'high', assignee_id: 'u-1' }),
      issue('a', { priority: 'low', assignee_id: null, cycle_id: 'c-1' })
    );
    expect(revert?.patch).toEqual({
      priority: 'high',
      assignee_id: 'u-1',
      cycle_id: null,
    });
    expect(revert?.bulk).toEqual(revert?.patch);
    expect(revert?.fields).toEqual(['priority', 'assignee_id', 'cycle_id']);
  });

  it('sends an issue that waited in triage back to triage', () => {
    const revert = revertBetween(
      issue('a', { in_triage: true }),
      issue('a', { status_id: 'st-done', in_triage: false })
    );
    expect(revert?.patch.status_id).toBe(TRIAGE_STATUS_ID);
    expect(revert?.restore).toMatchObject({
      status_id: 'st-todo',
      in_triage: true,
    });
  });

  it('restores labels as a full list and as a bulk add and remove', () => {
    const revert = revertBetween(
      issue('a', { label_ids: ['l-1', 'l-2'] }),
      issue('a', { label_ids: ['l-2', 'l-3'] })
    );
    expect(revert?.patch.label_ids).toEqual(['l-1', 'l-2']);
    expect(revert?.bulk).toEqual({
      add_label_ids: ['l-1'],
      remove_label_ids: ['l-3'],
    });
  });

  it('keeps a revert of dates off the bulk route', () => {
    const revert = revertBetween(
      issue('a', { due_date: '2026-10-30', parent_id: 'p-1' }),
      issue('a')
    );
    expect(revert?.patch).toEqual({ due_date: '2026-10-30', parent_id: 'p-1' });
    expect(revert?.bulk).toBeNull();
  });

  it('sends a revert of the parent alone through the bulk route', () => {
    const revert = revertBetween(
      issue('a', { parent_id: 'p-1' }),
      issue('a', { parent_id: 'p-2' })
    );
    expect(revert?.patch).toEqual({ parent_id: 'p-1' });
    expect(revert?.bulk).toEqual({ parent_id: 'p-1' });
  });

  it('puts back the project and the milestone it cleared', () => {
    const before = issue('a', {
      project_id: 'pr-1',
      project_milestone_id: 'm-1',
    });
    const after = patchedIssue(before, { project_id: 'pr-2' });
    expect(after.project_milestone_id).toBeNull();
    expect(revertBetween(before, after)?.patch).toEqual({
      project_id: 'pr-1',
      project_milestone_id: 'm-1',
    });
  });
});

describe('describeChange', () => {
  it('names the field and issue, or counts issues', () => {
    const one = revertBetween(issue('a'), issue('a', { priority: 'low' }));
    const two = revertBetween(
      issue('b'),
      issue('b', { priority: 'low', estimate: 'M' })
    );
    if (one === null || two === null) throw new Error('no revert');
    const keyOf = (id: string) => `ENG-${id}`;
    expect(describeChange([one], keyOf)).toBe('Changed priority of ENG-a');
    expect(describeChange([two], keyOf)).toBe('Updated ENG-b');
    expect(describeChange([one, one], keyOf)).toBe(
      'Changed priority of 2 issues'
    );
  });
});

describe('writeReverts', () => {
  it('groups issues sharing one revert onto the bulk route', async () => {
    const reverts = ['a', 'b', 'c'].flatMap((id) => {
      const revert = revertBetween(
        issue(id),
        issue(id, { status_id: 'st-done' })
      );
      return revert === null ? [] : [revert];
    });
    await writeReverts('ws-1', reverts);
    expect(updateIssue).not.toHaveBeenCalled();
    expect(bulkUpdateIssues).toHaveBeenCalledWith('ws-1', {
      issue_ids: ['a', 'b', 'c'],
      patch: { status_id: 'st-todo' },
    });
  });

  it('writes a lone or date revert through the single issue route', async () => {
    const lone = revertBetween(issue('a'), issue('a', { priority: 'low' }));
    const dated = revertBetween(
      issue('b'),
      issue('b', { due_date: '2026-10-30' })
    );
    if (lone === null || dated === null) throw new Error('no revert');
    await writeReverts('ws-1', [lone, dated]);
    expect(bulkUpdateIssues).not.toHaveBeenCalled();
    expect(updateIssue).toHaveBeenCalledWith('ws-1', 'a', {
      priority: 'medium',
    });
    expect(updateIssue).toHaveBeenCalledWith('ws-1', 'b', { due_date: null });
  });
});

describe('recording changes', () => {
  it('undoes a single issue patch with the previous values', async () => {
    const before = issue('a', { assignee_id: 'u-1', label_ids: ['l-1'] });
    const onReverted = vi.fn();
    expect(
      recordPatch(
        'ws-1',
        before,
        { assignee_id: null, label_ids: [], title: 'renamed' },
        { onReverted }
      )
    ).toBe(true);

    await undoLast('ws-1');
    expect(updateIssue).toHaveBeenCalledWith('ws-1', 'a', {
      assignee_id: 'u-1',
      label_ids: ['l-1'],
    });
    expect(onReverted).toHaveBeenCalledTimes(1);
  });

  it('records nothing for a title alone', () => {
    expect(recordPatch('ws-1', issue('a'), { title: 'renamed' })).toBe(false);
  });

  it('undoes a delete by restoring each issue from the trash', async () => {
    const onReverted = vi.fn();
    recordDelete('ws-1', [issue('a'), issue('b')], { onReverted });

    await undoLast('ws-1');
    expect(restoreIssue).toHaveBeenCalledWith('ws-1', 'a');
    expect(restoreIssue).toHaveBeenCalledWith('ws-1', 'b');
    expect(onReverted).toHaveBeenCalledWith([issue('a'), issue('b')]);
  });

  it('records nothing for an empty delete', async () => {
    recordDelete('ws-1', []);

    await undoLast('ws-1');
    expect(restoreIssue).not.toHaveBeenCalled();
  });

  it('moves an issue back and puts back what the move dropped', async () => {
    const before = issue('a', {
      status_id: 'st-review',
      cycle_id: 'c-1',
      label_ids: ['l-1'],
    });
    moveIssue.mockResolvedValue(
      issue('a', { status_id: 'st-todo', team_id: 'team-1' })
    );
    recordMove('ws-1', before, 'Moved ENG-a to Ops as OPS-1');

    await undoLast('ws-1');
    expect(moveIssue).toHaveBeenCalledWith('ws-1', 'a', 'team-1');
    expect(updateIssue).toHaveBeenCalledWith('ws-1', 'a', {
      status_id: 'st-review',
      cycle_id: 'c-1',
      label_ids: ['l-1'],
    });
  });
});
