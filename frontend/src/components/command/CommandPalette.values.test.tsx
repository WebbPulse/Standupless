/**
 * Property values as top level palette commands: with an issue page in view,
 * typing a value's name offers the action that sets it, which writes through
 * the page's own update, a value that starts with the term ranks first, only
 * the first few values are listed, and nothing is offered without an issue in
 * focus or when the viewer cannot edit it.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueRead, IssueUpdate, LabelRead } from '../../types/Api';
import IssuePageCommands from '../issues/IssuePageCommands';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
import CommandPalette from './CommandPalette';

vi.mock('../../hooks/useWorkspaceMembers', () => ({
  useWorkspaceMembers: () => [],
}));

vi.mock('../../api/documents', () => ({
  listWorkspaceDocuments: () => Promise.resolve([]),
}));

vi.mock('../../api/views', () => ({
  search: () => Promise.resolve([]),
}));

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

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

const baseLabels: LabelRead[] = [
  { id: 'lb-1', name: 'Bug', color: '#f00' },
  { id: 'lb-2', name: 'Infra', color: '#0f0' },
];

let onUpdate: ReturnType<typeof vi.fn<(patch: IssueUpdate) => void>>;

/** Renders the open palette, over an issue page unless `page` is false. */
const renderPalette = ({
  page = true,
  canEdit = true,
  labels = baseLabels,
}: {
  page?: boolean;
  canEdit?: boolean;
  labels?: LabelRead[];
} = {}): void => {
  render(
    <MemoryRouter initialEntries={['/w/mine']}>
      <ShortcutProvider>
        {page && (
          <IssuePageCommands
            slug="mine"
            issue={issue}
            statuses={[
              { id: 'st-1', name: 'Todo', category: 'unstarted', position: 0 },
              {
                id: 'st-2',
                name: 'In Progress',
                category: 'started',
                position: 1,
              },
            ]}
            labels={labels}
            people={[
              {
                user_id: 'user-1',
                email: 'me@example.com',
                display_name: 'Me',
              },
              {
                user_id: 'user-2',
                email: 'alex@example.com',
                display_name: 'Alex',
              },
            ]}
            projects={[]}
            cycles={[]}
            estimateScale="off"
            currentUserId="user-1"
            canEdit={canEdit}
            onUpdate={onUpdate}
          />
        )}
        <CommandPalette
          open
          onClose={vi.fn()}
          workspace={{ id: 'ws-1', slug: 'mine', role: 'owner' }}
          teams={[]}
        />
      </ShortcutProvider>
    </MemoryRouter>
  );
};

/** The rows listed under the property values heading. */
const valueRows = (): string[] => {
  const group = screen.queryByRole('group', { name: 'Change property' });
  return group === null
    ? []
    : within(group)
        .getAllByRole('option')
        .map((row) => row.textContent);
};

beforeEach(() => {
  onUpdate = vi.fn<(patch: IssueUpdate) => void>();
});

describe('property values in the command palette', () => {
  it('sets the priority a typed value names on the issue in view', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.type(screen.getByRole('combobox'), 'urgent');
    await user.click(
      await screen.findByRole('option', { name: /Set priority to Urgent/ })
    );

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({ priority: 'urgent' });
    });
  });

  it('assigns the teammate a typed name matches', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.type(screen.getByRole('combobox'), 'alex');
    await user.click(
      await screen.findByRole('option', { name: /Assign to Alex/ })
    );

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({ assignee_id: 'user-2' });
    });
  });

  it('changes the status a typed name matches', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.type(screen.getByRole('combobox'), 'in progress');
    await user.click(
      await screen.findByRole('option', {
        name: /Change status to In Progress/,
      })
    );

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({ status_id: 'st-2' });
    });
  });

  it('adds a label and offers removing one the issue carries', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.type(screen.getByRole('combobox'), 'label');

    expect(valueRows()).toEqual(['Remove label Bug', 'Add label Infra']);
  });

  it('leaves out the value the issue already has', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.type(screen.getByRole('combobox'), 'priority');

    const rows = valueRows();
    expect(rows).toContain('Set priority to Urgent');
    expect(rows).not.toContain('Set priority to High');
  });

  it('ranks a value whose name starts with the term first', async () => {
    const user = userEvent.setup();
    renderPalette({
      labels: [
        { id: 'lb-1', name: 'Bug', color: '#f00' },
        { id: 'lb-3', name: 'Regression', color: '#00f' },
      ],
    });

    await user.type(screen.getByRole('combobox'), 're');

    expect(valueRows()[0]).toBe('Add label Regression');
  });

  it('lists only the first few values', async () => {
    const user = userEvent.setup();
    renderPalette({
      labels: Array.from({ length: 12 }, (_, index) => ({
        id: `lb-${String(index + 10)}`,
        name: `Area ${String(index + 10)}`,
        color: '#888',
      })),
    });

    await user.type(screen.getByRole('combobox'), 'area');

    expect(valueRows()).toHaveLength(8);
  });

  it('offers no values when the viewer cannot edit the issue', async () => {
    const user = userEvent.setup();
    renderPalette({ canEdit: false });

    await user.type(screen.getByRole('combobox'), 'urgent');

    expect(valueRows()).toEqual([]);
  });

  it('offers no values with no issue in focus', async () => {
    const user = userEvent.setup();
    renderPalette({ page: false });

    await user.type(screen.getByRole('combobox'), 'urgent');

    expect(valueRows()).toEqual([]);
  });
});
