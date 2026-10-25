/**
 * Filing sub-issues: the create body carries the parent's team, priority and
 * project but never its labels, the caller's fields win, the parent's assignee
 * follows by Linear's rule, and a run files the drafts in order and stops at
 * the first failure.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueCreate, IssueRead } from '../types/Api';
import {
  createSubIssues,
  inheritedAssignee,
  parentOfIssue,
  subIssueBody,
  subIssueDialogPresets,
  type ResolvedSubIssueParent,
} from './subIssueCreation';
import { clearToasts } from './toast';

const createIssue = vi.fn<(body: IssueCreate) => Promise<IssueRead>>();
const getIssue = vi.fn<(id: string) => Promise<IssueRead>>();

vi.mock('../api/issues', () => ({
  createIssue: (_w: string, body: IssueCreate) => createIssue(body),
  getIssue: (_w: string, id: string) => getIssue(id),
}));

const parent: ResolvedSubIssueParent = {
  id: 'p-1',
  key: 'ENG-1',
  teamId: 'team-1',
  priority: 'high',
  projectId: 'proj-1',
};

const filed = (key: string): IssueRead => ({ key }) as unknown as IssueRead;

beforeEach(() => {
  createIssue.mockReset();
  getIssue.mockReset();
  clearToasts();
});

describe('subIssueBody', () => {
  it('inherits team, priority and project', () => {
    expect(subIssueBody(parent, { title: 'Child' })).toEqual({
      team_id: 'team-1',
      parent_id: 'p-1',
      title: 'Child',
      priority: 'high',
      project_id: 'proj-1',
    });
  });

  it('leaves out a parent with no priority or project', () => {
    expect(
      subIssueBody(
        { ...parent, priority: 'none', projectId: null },
        { title: 'Child', body: '' }
      )
    ).toEqual({ team_id: 'team-1', parent_id: 'p-1', title: 'Child' });
  });

  it('lets the caller set the status, priority and assignee', () => {
    expect(
      subIssueBody(
        parent,
        { title: 'Child', body: 'More' },
        { status_id: 'st-2', priority: 'none', assignee_id: 'u-1' }
      )
    ).toMatchObject({
      body: 'More',
      status_id: 'st-2',
      priority: 'none',
      assignee_id: 'u-1',
    });
  });

  it('never carries labels', () => {
    const issue = {
      id: 'p-2',
      key: 'ENG-2',
      team_id: 'team-2',
      priority: 'low',
      project_id: null,
      label_ids: ['l-1'],
    } as unknown as IssueRead;
    expect(
      subIssueBody(parentOfIssue(issue), { title: 'A' })
    ).not.toHaveProperty('label_ids');
  });
});

describe('subIssueDialogPresets', () => {
  it("presets the parent's team, key, priority and project", () => {
    expect(subIssueDialogPresets(parent)).toEqual({
      teamId: 'team-1',
      parentId: 'p-1',
      parentKey: 'ENG-1',
      priority: 'high',
      projectId: 'proj-1',
    });
  });

  it('leaves out a priority of none and a missing project', () => {
    expect(
      subIssueDialogPresets({ ...parent, priority: 'none', projectId: null })
    ).toEqual({ teamId: 'team-1', parentId: 'p-1', parentKey: 'ENG-1' });
  });

  it('reads the presets from an issue row, never its labels', () => {
    const presets = subIssueDialogPresets(
      parentOfIssue({
        id: 'p-2',
        key: 'ENG-2',
        team_id: 'team-2',
        priority: 'urgent',
        project_id: 'proj-2',
      })
    );
    expect(presets).toEqual({
      teamId: 'team-2',
      parentId: 'p-2',
      parentKey: 'ENG-2',
      priority: 'urgent',
      projectId: 'proj-2',
    });
    expect(presets).not.toHaveProperty('labelIds');
  });
});

describe('inheritedAssignee', () => {
  it('passes the parent down to the creator who holds it', () => {
    expect(inheritedAssignee('u-1', 'u-1', ['u-2'])).toBe('u-1');
    expect(inheritedAssignee('u-1', 'u-1', undefined)).toBe('u-1');
  });

  it('counts no siblings as sharing the assignee', () => {
    expect(inheritedAssignee('u-1', 'u-9', [])).toBe('u-1');
  });

  it('follows siblings that all share it and stops at a mixed set', () => {
    expect(inheritedAssignee('u-1', 'u-9', ['u-1', 'u-1'])).toBe('u-1');
    expect(inheritedAssignee('u-1', 'u-9', ['u-1', null])).toBeNull();
    expect(inheritedAssignee('u-1', 'u-9', ['u-1', 'u-2'])).toBeNull();
  });

  it('leaves it to the server while the siblings are unknown', () => {
    expect(inheritedAssignee('u-1', 'u-9', undefined)).toBeNull();
    expect(inheritedAssignee('u-1', undefined, undefined)).toBeNull();
  });

  it('passes nothing down from an unassigned parent', () => {
    expect(inheritedAssignee(null, 'u-1', [])).toBeNull();
    expect(inheritedAssignee(undefined, 'u-1', [])).toBeNull();
  });
});

describe('subIssueDialogPresets with an assignee', () => {
  const assigned = { ...parent, assigneeId: 'u-1' };

  it("presets the parent's assignee by the creation rule", () => {
    expect(subIssueDialogPresets(assigned, { creatorId: 'u-1' })).toMatchObject(
      { assigneeId: 'u-1' }
    );
    expect(
      subIssueDialogPresets(assigned, {
        creatorId: 'u-9',
        siblingAssigneeIds: [],
      })
    ).toMatchObject({ assigneeId: 'u-1' });
  });

  it('presets no assignee when the rule does not hold', () => {
    expect(
      subIssueDialogPresets(assigned, {
        creatorId: 'u-9',
        siblingAssigneeIds: ['u-2'],
      })
    ).not.toHaveProperty('assigneeId');
    expect(subIssueDialogPresets(assigned)).not.toHaveProperty('assigneeId');
  });

  it("reads the parent's assignee from an issue row", () => {
    expect(
      parentOfIssue({
        id: 'p-3',
        key: 'ENG-3',
        team_id: 'team-3',
        priority: 'none',
        project_id: null,
        assignee_id: 'u-1',
      })
    ).toMatchObject({ assigneeId: 'u-1' });
  });
});

describe('createSubIssues', () => {
  it('files the drafts in order', async () => {
    createIssue
      .mockResolvedValueOnce(filed('ENG-2'))
      .mockResolvedValueOnce(filed('ENG-3'));

    const run = await createSubIssues('ws-1', parent, [
      { title: 'One' },
      { title: 'Two' },
    ]);

    expect(createIssue.mock.calls.map(([body]) => body.title)).toEqual([
      'One',
      'Two',
    ]);
    expect(run.created.map((issue) => issue.key)).toEqual(['ENG-2', 'ENG-3']);
    expect(run.failed).toBeNull();
    expect(getIssue).not.toHaveBeenCalled();
  });

  it('stops at the first failure and keeps what was filed', async () => {
    createIssue
      .mockResolvedValueOnce(filed('ENG-2'))
      .mockRejectedValueOnce(new Error('nope'));

    const run = await createSubIssues('ws-1', parent, [
      { title: 'One' },
      { title: 'Two' },
      { title: 'Three' },
    ]);

    expect(createIssue).toHaveBeenCalledTimes(2);
    expect(run.created).toHaveLength(1);
    expect(run.failed).toBeInstanceOf(Error);
  });

  it('reads the parent when only its id is known', async () => {
    getIssue.mockResolvedValue({
      id: 'p-1',
      key: 'ENG-1',
      team_id: 'team-9',
      priority: 'none',
      project_id: null,
    } as unknown as IssueRead);
    createIssue.mockResolvedValueOnce(filed('ENG-2'));

    await createSubIssues('ws-1', { id: 'p-1' }, [{ title: 'One' }]);

    expect(createIssue).toHaveBeenCalledWith({
      team_id: 'team-9',
      parent_id: 'p-1',
      title: 'One',
    });
  });
});
