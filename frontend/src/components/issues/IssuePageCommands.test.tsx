/**
 * The issue page's keys: the list's pickers write through the page's update as
 * an IssueUpdate patch, labels arrive as the whole label_ids set, and Cmd or
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
import type { CycleRead, IssueRead, IssueUpdate } from '../../types/Api';
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

let registry: ShortcutRegistry;
let onUpdate: ReturnType<typeof vi.fn<(patch: IssueUpdate) => void>>;
let onDelete: ReturnType<typeof vi.fn<() => Promise<void>>>;

/** Mounts the page commands inside a shortcut registry. */
const renderCommands = (canEdit = true) => {
  render(
    <MemoryRouter>
      <ShortcutRegistryContext.Provider value={registry}>
        <IssuePageCommands
          slug="mine"
          issue={issue}
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
