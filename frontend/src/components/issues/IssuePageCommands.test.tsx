/**
 * The issue page's keys: the list's pickers write through the page's update as
 * an IssueUpdate patch, I assigns the issue to the viewer or back off them,
 * Shift+M picks a milestone of the issue's project, labels arrive as the whole label_ids set, and Cmd or
 * Ctrl+Backspace deletes only after the confirmation.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
} from '../../types/Api';
import IssuePageCommands from './IssuePageCommands';

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
  milestones: MilestoneRead[] = []
) => {
  render(
    <MemoryRouter>
      <ShortcutRegistryContext.Provider value={registry}>
        <IssuePageCommands
          slug="mine"
          issue={shown}
          statuses={[
            { id: 'st-1', name: 'Todo', category: 'unstarted', position: 0 },
          ]}
          labels={[
            { id: 'lb-1', name: 'Bug', color: '#f00' },
            { id: 'lb-2', name: 'Infra', color: '#0f0' },
          ]}
          people={[
            { user_id: 'user-1', email: 'me@example.com', display_name: 'Me' },
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

  it('binds nothing for a reader who cannot edit', () => {
    renderCommands(false);
    press('C', { shiftKey: true });
    press('Backspace', { ctrlKey: true });

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
