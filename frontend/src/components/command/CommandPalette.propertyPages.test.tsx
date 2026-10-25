/**
 * Property sub-pages in the command palette: with an issue page in view, a
 * property action such as "Change status" opens the property's values inside
 * the palette under a breadcrumb naming the issue, the current value is
 * checked, picking a value writes through the page's own update, and
 * Backspace on an empty term goes back. Every shortcut hint is drawn as key
 * caps.
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

/** The palette's input. */
const input = (): HTMLElement => screen.getByRole('combobox');

/** Opens the sub-page of the issue action whose row matches the name. */
const openSubPage = async (
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp
): Promise<void> => {
  await user.click(await screen.findByRole('option', { name }));
  await screen.findByTestId('palette-breadcrumb');
};

beforeEach(() => {
  onUpdate = vi.fn<(patch: IssueUpdate) => void>();
});

describe('property sub-pages in the command palette', () => {
  it('lists the property actions with a trailing ellipsis', async () => {
    renderPalette();

    const group = await screen.findByRole('group', { name: 'Current issue' });
    const labels = within(group)
      .getAllByRole('option')
      .map((row) => row.textContent);
    expect(
      labels.some((label) => label.startsWith('Change status\u2026'))
    ).toBe(true);
    expect(labels.some((label) => label.startsWith('Assign to\u2026'))).toBe(
      true
    );
  });

  it('opens the status values under a breadcrumb naming the issue', async () => {
    const user = userEvent.setup();
    renderPalette();

    await openSubPage(user, /Change status\u2026/);

    const crumb = screen.getByTestId('palette-breadcrumb');
    expect(crumb).toHaveTextContent('ENG-1');
    expect(crumb).toHaveTextContent('Change status');
    expect(input()).toHaveAttribute('placeholder', 'Change status to\u2026');
    const rows = screen.getAllByRole('option');
    expect(rows.map((row) => row.textContent)).toEqual(['Todo', 'In Progress']);
    expect(rows[0]).toHaveAttribute('aria-checked', 'true');
    expect(rows[1]).toHaveAttribute('aria-checked', 'false');
  });

  it('writes the picked value through the page', async () => {
    const user = userEvent.setup();
    renderPalette();

    await openSubPage(user, /Change status\u2026/);
    await user.click(screen.getByRole('option', { name: /In Progress/ }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({ status_id: 'st-2' });
    });
  });

  it('filters the values by the typed term and picks on Enter', async () => {
    const user = userEvent.setup();
    renderPalette();

    await openSubPage(user, /Assign to\u2026/);
    await user.type(input(), 'alex');

    expect(screen.getAllByRole('option')[0]).toHaveTextContent('Alex');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({ assignee_id: 'user-2' });
    });
  });

  it('changes nothing when the current value is picked', async () => {
    const user = userEvent.setup();
    renderPalette();

    await openSubPage(user, /Change status\u2026/);
    await user.click(screen.getByRole('option', { name: /Todo/ }));

    await new Promise((resolve) => {
      globalThis.setTimeout(resolve, 10);
    });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('checks the labels the issue carries', async () => {
    const user = userEvent.setup();
    renderPalette();

    await openSubPage(user, /Change labels\u2026/);

    expect(screen.getByRole('option', { name: /Bug/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('option', { name: /Infra/ })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('goes back to the top level on Backspace with an empty term', async () => {
    const user = userEvent.setup();
    renderPalette();

    await openSubPage(user, /Change priority\u2026/);
    await user.type(input(), 'u');
    await user.keyboard('{Backspace}');
    expect(screen.getByTestId('palette-breadcrumb')).toBeInTheDocument();

    await user.keyboard('{Backspace}');

    expect(screen.queryByTestId('palette-breadcrumb')).toBeNull();
    expect(input()).toHaveAttribute('placeholder', 'Type a command or search');
    expect(screen.getByTestId('palette-subject')).toHaveTextContent('ENG-1');
  });

  it('goes back when the breadcrumb is clicked', async () => {
    const user = userEvent.setup();
    renderPalette();

    await openSubPage(user, /Change status\u2026/);
    await user.click(screen.getByTestId('palette-breadcrumb'));

    expect(
      await screen.findByRole('option', { name: /Change status\u2026/ })
    ).toBeInTheDocument();
  });

  it('keeps the current value out of the top level search', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.type(input(), 'todo');

    const group = screen.queryByRole('group', { name: 'Change property' });
    const rows =
      group === null
        ? []
        : within(group)
            .getAllByRole('option')
            .map((row) => row.textContent);
    expect(rows).not.toContain('Change status to Todo');
  });

  it('opens no sub-page when the viewer cannot edit the issue', async () => {
    renderPalette({ canEdit: false });

    await screen.findByRole('option', { name: /Go to Inbox/ });
    expect(screen.queryByRole('option', { name: /\u2026/ })).toBeNull();
  });
});

describe('shortcut hints in the command palette', () => {
  it('draws a sequence as key caps with then between them', async () => {
    renderPalette({ page: false });

    const row = await screen.findByRole('option', { name: /Go to Inbox/ });
    const caps = Array.from(row.querySelectorAll('kbd')).map(
      (cap) => cap.textContent
    );
    expect(caps).toEqual(['G', 'I']);
    expect(row).toHaveTextContent('G then I');
  });

  it('draws a single key as one cap on the issue actions', async () => {
    renderPalette();

    const row = await screen.findByRole('option', {
      name: /Change status\u2026/,
    });
    expect(
      Array.from(row.querySelectorAll('kbd')).map((cap) => cap.textContent)
    ).toEqual(['S']);
  });

  it('labels the places as where they go', async () => {
    renderPalette({ page: false });

    expect(
      await screen.findByRole('option', { name: /^Go to My issues/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /^Go to Roadmap/ })
    ).toBeInTheDocument();
  });
});
