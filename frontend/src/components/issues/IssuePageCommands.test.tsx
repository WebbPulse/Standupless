/**
 * The issue page's keys: the list's pickers write through the page's update as
 * an IssueUpdate patch, I assigns the issue to the viewer or back off them,
 * Shift+M picks a milestone of the issue's project, labels arrive as the whole label_ids set, and Cmd or
 * Ctrl+Backspace deletes only after the confirmation, unless the surface
 * around the page takes that key, and Cmd or Ctrl+Shift+C,
 * D and L add the issue to the active cycle, clear its due date and clear its
 * labels, Cmd or Ctrl+Alt+1 to 9 set the status at that workflow position,
 * and the palette offers Copy issue as Markdown.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
  type ShortcutRegistry,
} from '../../hooks/useShortcuts';
import type {
  CycleRead,
  IssueRead,
  IssueUpdate,
  MilestoneRead,
  StatusRead,
} from '../../types/Api';
import { issuePath } from '../../lib/paths';
import { SUB_ISSUE_DISPLAY_KEY } from '../../lib/subIssues';
import IssuePageCommands from './IssuePageCommands';
import { DeleteIssueKeyContext } from './view/propertyKeys';

vi.mock(
  '../../hooks/useProjectStatuses',
  () => import('../../test/projectStatuses')
);

const issue: IssueRead = {
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: 'ENG-1',
  number: 1,
  title: 'Cache the token',
  body: null,
  status_id: 'st-1',
  priority: 'high',
  assignee_id: null,
  label_ids: ['lb-1'],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: null,
  project_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
};

const cycles = [
  {
    cycle_id: 'cy-1',
    workspace_id: 'ws-1',
    team_id: 'team-1',
    name: 'Cycle 12',
    start_date: '2026-09-21',
    end_date: '2026-10-04',
    goal: null,
    cancelled: false,
    status: 'active',
    counts: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
    created_by: 'user-1',
    created_at: '2026-09-17T00:00:00Z',
    updated_at: '2026-09-17T00:00:00Z',
  },
] as CycleRead[];

const milestone = {
  milestone_id: 'ms-1',
  project_id: 'pr-1',
  name: 'Beta',
} as MilestoneRead;

let registry: ShortcutRegistry;
let onUpdate: ReturnType<typeof vi.fn<(patch: IssueUpdate) => void>>;
let onDelete: ReturnType<typeof vi.fn<() => Promise<void>>>;

/** Mounts the page commands inside a shortcut registry. */
const renderCommands = (
  canEdit = true,
  shown: IssueRead = issue,
  milestones: MilestoneRead[] = [],
  statuses: StatusRead[] = [
    { id: 'st-1', name: 'Todo', category: 'unstarted', position: 0 },
  ],
  bindsDelete = true
) => {
  render(
    <MemoryRouter>
      <ShortcutRegistryContext.Provider value={registry}>
        <DeleteIssueKeyContext.Provider value={bindsDelete}>
          <IssuePageCommands
            slug="mine"
            issue={shown}
            statuses={statuses}
            labels={[
              { id: 'lb-1', name: 'Bug', color: '#f00' },
              { id: 'lb-2', name: 'Infra', color: '#0f0' },
            ]}
            people={[
              {
                user_id: 'user-1',
                email: 'me@example.com',
                display_name: 'Me',
              },
            ]}
            projects={[]}
            cycles={cycles}
            milestones={milestones}
            estimateScale="off"
            currentUserId="user-1"
            canEdit={canEdit}
            onUpdate={onUpdate}
            onDelete={onDelete}
          />
        </DeleteIssueKeyContext.Provider>
      </ShortcutRegistryContext.Provider>
    </MemoryRouter>
  );
};

/** Feeds one key press to the registry, as the provider's listener would. */
const press = (key: string, init: KeyboardEventInit = {}): void => {
  act(() => {
    registry.handleKey(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      })
    );
  });
};

beforeEach(() => {
  registry = createShortcutRegistry();
  onUpdate = vi.fn<(patch: IssueUpdate) => void>();
  onDelete = vi.fn<() => Promise<void>>(() => Promise.resolve());
});

describe('IssuePageCommands', () => {
  it('moves the issue to a cycle on Shift+C', () => {
    renderCommands();
    press('C', { shiftKey: true });

    fireEvent.click(screen.getByRole('option', { name: /Cycle 12/ }));

    expect(onUpdate).toHaveBeenCalledWith({ cycle_id: 'cy-1' });
  });

  it('writes a label toggle as the whole label set', () => {
    renderCommands();
    press('l');

    fireEvent.click(screen.getByRole('option', { name: /Infra/ }));

    expect(onUpdate).toHaveBeenCalledWith({ label_ids: ['lb-1', 'lb-2'] });
  });

  it('assigns the issue to the viewer on I', () => {
    renderCommands();
    press('i');

    expect(onUpdate).toHaveBeenCalledWith({ assignee_id: 'user-1' });
  });

  it("unassigns on I when the issue is already the viewer's", () => {
    renderCommands(true, { ...issue, assignee_id: 'user-1' });
    press('i');

    expect(onUpdate).toHaveBeenCalledWith({ assignee_id: null });
  });

  it("sets a milestone of the issue's project on Shift+M", () => {
    renderCommands(true, { ...issue, project_id: 'pr-1' }, [milestone]);
    press('M', { shiftKey: true });

    fireEvent.click(screen.getByRole('option', { name: /Beta/ }));

    expect(onUpdate).toHaveBeenCalledWith({ project_milestone_id: 'ms-1' });
  });

  it('lists I and Shift+M under Issue for the overlay and the palette', () => {
    renderCommands(true, { ...issue, project_id: 'pr-1' }, [milestone]);

    const listed = registry
      .list()
      .filter((shortcut) => ['i', 'shift+m'].includes(shortcut.keys))
      .map((shortcut) => [
        shortcut.keys,
        shortcut.scope,
        shortcut.group,
        shortcut.label,
      ]);
    expect(listed).toEqual(
      expect.arrayContaining([
        ['i', 'issue', 'Issue', 'Assign to me'],
        ['shift+m', 'issue', 'Issue', 'Set milestone'],
      ])
    );
  });

  it('offers no milestone key when the issue has no project', () => {
    renderCommands(true, issue, [milestone]);
    press('M', { shiftKey: true });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      registry.list().some((shortcut) => shortcut.keys === 'shift+m')
    ).toBe(false);
  });

  it('deletes only after the confirmation', async () => {
    renderCommands();
    press('Backspace', { metaKey: true });

    expect(onDelete).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm).toHaveFocus();
    await act(async () => {
      fireEvent.submit(confirm);
      await Promise.resolve();
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('leaves Cmd or Ctrl+Backspace to a surface that takes it', () => {
    renderCommands(true, issue, [], undefined, false);
    press('Backspace', { ctrlKey: true });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('binds nothing for a reader who cannot edit', () => {
    renderCommands(false);
    press('C', { shiftKey: true });
    press('Backspace', { ctrlKey: true });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers Copy issue as Markdown in the palette, even to a reader, and copies it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderCommands(false, { ...issue, body: 'Tokens expire.' });

    const command = registry
      .list()
      .find((shortcut) => shortcut.label === 'Copy issue as Markdown');
    expect(command).toMatchObject({ keys: '', scope: 'issue', group: 'Issue' });
    act(() => {
      command?.run();
    });

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        `# [ENG-1 Cache the token](${globalThis.location.origin}${issuePath('mine', 'ENG-1')})\n\n` +
          '**Status:** Todo · **Priority:** High · **Labels:** Bug\n\n' +
          'Tokens expire.\n'
      );
    });
  });
});

describe('walking the issue tree from the page', () => {
  const statuses: StatusRead[] = [
    { id: 'st-1', name: 'Todo', category: 'unstarted', position: 0 },
    { id: 'st-9', name: 'Done', category: 'completed', position: 1 },
  ];

  /** Shows the address the commands navigated to. */
  const Where = () => <output>{useLocation().pathname}</output>;

  /** Mounts the commands with the tree the page holds. */
  const renderTree = (
    shown: IssueRead,
    knownIssues: IssueRead[] = [],
    subIssues: IssueRead[] = []
  ) => {
    render(
      <MemoryRouter initialEntries={[issuePath('mine', 'ENG-1')]}>
        <ShortcutRegistryContext.Provider value={registry}>
          <IssuePageCommands
            slug="mine"
            issue={shown}
            statuses={statuses}
            labels={[]}
            people={[]}
            projects={[]}
            cycles={[]}
            estimateScale="off"
            currentUserId="user-1"
            canEdit
            onUpdate={onUpdate}
            knownIssues={knownIssues}
            subIssues={subIssues}
          />
          <Where />
        </ShortcutRegistryContext.Provider>
      </MemoryRouter>
    );
  };

  const parent: IssueRead = { ...issue, id: 'iss-0', key: 'ENG-0' };

  it('opens the parent on Ctrl+Shift+Up', () => {
    renderTree({ ...issue, parent_id: 'iss-0' }, [parent]);
    press('ArrowUp', { ctrlKey: true, shiftKey: true });

    expect(screen.getByRole('status')).toHaveTextContent(
      issuePath('mine', 'ENG-0')
    );
  });

  it('opens the first sub-issue shown on Cmd+Shift+Down', () => {
    const children = [
      { ...issue, id: 'iss-3', key: 'ENG-3', sort_order: 'c' },
      {
        ...issue,
        id: 'iss-2',
        key: 'ENG-2',
        sort_order: 'a',
        status_id: 'st-9',
      },
      { ...issue, id: 'iss-4', key: 'ENG-4', sort_order: 'b' },
    ];
    localStorage.setItem(
      SUB_ISSUE_DISPLAY_KEY,
      JSON.stringify({ ordering: 'manual', showCompleted: false })
    );
    renderTree(
      { ...issue, progress: { total: 3, completed: 1 } },
      [],
      children
    );
    press('ArrowDown', { metaKey: true, shiftKey: true });
    localStorage.removeItem(SUB_ISSUE_DISPLAY_KEY);

    expect(screen.getByRole('status')).toHaveTextContent(
      issuePath('mine', 'ENG-4')
    );
  });

  it('stays put without a parent or sub-issues', () => {
    renderTree(issue);
    press('ArrowUp', { ctrlKey: true, shiftKey: true });
    press('ArrowDown', { ctrlKey: true, shiftKey: true });

    expect(screen.getByRole('status')).toHaveTextContent(
      issuePath('mine', 'ENG-1')
    );
    expect(
      registry
        .list()
        .some((shortcut) => shortcut.keys.startsWith('mod+shift+arrow'))
    ).toBe(false);
  });

  it('lists both under Navigation for the overlay and the palette', () => {
    renderTree(
      { ...issue, parent_id: 'iss-0', progress: { total: 1, completed: 0 } },
      [parent],
      [{ ...issue, id: 'iss-2', key: 'ENG-2' }]
    );

    const listed = registry
      .list()
      .filter((shortcut) => shortcut.group === 'Navigation')
      .map(({ keys, label, scope }) => ({ keys, label, scope }));
    expect(listed).toEqual(
      expect.arrayContaining([
        {
          keys: 'mod+shift+arrowup',
          label: 'Open parent issue',
          scope: 'issue',
        },
        {
          keys: 'mod+shift+arrowdown',
          label: 'Open first sub-issue',
          scope: 'issue',
        },
      ])
    );
  });
});

describe('IssuePageCommands quick actions', () => {
  const modShift = { ctrlKey: true, shiftKey: true };

  it('adds the issue to the active cycle on Cmd or Ctrl+Shift+C', async () => {
    renderCommands();
    press('C', modShift);

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({ cycle_id: 'cy-1' });
    });
  });

  it('clears the due date on Cmd or Ctrl+Shift+D', () => {
    renderCommands(true, { ...issue, due_date: '2026-11-01' });
    press('D', modShift);

    expect(onUpdate).toHaveBeenCalledWith({ due_date: null });
  });

  it('clears the labels on Cmd or Ctrl+Shift+L', () => {
    renderCommands();
    press('L', modShift);

    expect(onUpdate).toHaveBeenCalledWith({ label_ids: [] });
  });

  it('binds none of them for a viewer who cannot edit', () => {
    renderCommands(false, { ...issue, due_date: '2026-11-01' });
    press('C', modShift);
    press('D', modShift);
    press('L', modShift);

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('sets the status at a workflow position on Cmd or Ctrl+Alt and a digit', () => {
    renderCommands(
      true,
      issue,
      [],
      [
        { id: 'st-3', name: 'Done', category: 'completed', position: 0 },
        { id: 'st-2', name: 'In Progress', category: 'started', position: 0 },
        { id: 'st-1', name: 'Todo', category: 'unstarted', position: 0 },
      ]
    );

    press('2', { ctrlKey: true, altKey: true, code: 'Digit2' });
    expect(onUpdate).toHaveBeenCalledWith({ status_id: 'st-2' });

    press('∞', { metaKey: true, altKey: true, code: 'Digit5' });
    press('1', { ctrlKey: true, altKey: true, code: 'Digit1' });
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('names each status position shortcut after its status', () => {
    renderCommands(
      true,
      issue,
      [],
      [
        { id: 'st-1', name: 'Todo', category: 'unstarted', position: 0 },
        { id: 'st-2', name: 'In Progress', category: 'started', position: 0 },
      ]
    );

    const labels = registry
      .list()
      .filter((shortcut) => /^mod\+alt\+[12]$/.test(shortcut.keys))
      .map((shortcut) => [shortcut.keys, shortcut.label, shortcut.group]);
    expect(labels).toEqual([
      ['mod+alt+1', 'Set status to Todo', 'Issue'],
      ['mod+alt+2', 'Set status to In Progress', 'Issue'],
    ]);
  });
});
