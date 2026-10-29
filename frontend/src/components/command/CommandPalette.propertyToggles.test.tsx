/**
 * The command palette's multi-select label list and its milestone and due
 * date lists, as in Linear: picking a label toggles it on the issue and keeps
 * the list open with its checks redrawn and the term cleared, Escape closes
 * it, the milestone list checks the issue's milestone, and the due date list
 * offers the date presets and leads with the day a typed term names.
 */

import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  IssueRead,
  IssueUpdate,
  LabelRead,
  MilestoneRead,
} from '../../types/Api';
import { datePresets, typedDateOption } from '../../lib/propertyOptions';
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

const baseIssue: IssueRead = {
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

const labels: LabelRead[] = [
  { id: 'lb-1', name: 'Bug', color: '#f00' },
  { id: 'lb-2', name: 'Infra', color: '#0f0' },
  { id: 'lb-3', name: 'Docs', color: '#00f' },
];

/** A milestone of project pr-1. */
const milestone = (id: string, name: string): MilestoneRead => ({
  milestone_id: id,
  project_id: 'pr-1',
  workspace_id: 'ws-1',
  name,
  description: null,
  target_date: null,
  sort_order: id,
  counts: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
});

const milestones = [milestone('ms-1', 'Alpha'), milestone('ms-2', 'Beta')];

let onUpdate: ReturnType<typeof vi.fn<(patch: IssueUpdate) => void>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;

/** An issue page whose writes land on the issue it shows. */
const Page = ({ start }: { start: IssueRead }) => {
  const [issue, setIssue] = useState(start);
  return (
    <IssuePageCommands
      slug="mine"
      issue={issue}
      statuses={[
        { id: 'st-1', name: 'Todo', category: 'unstarted', position: 0 },
      ]}
      labels={labels}
      people={[
        { user_id: 'user-1', email: 'me@example.com', display_name: 'Me' },
      ]}
      projects={[]}
      cycles={[]}
      milestones={milestones}
      estimateScale="off"
      currentUserId="user-1"
      canEdit
      onUpdate={(patch) => {
        onUpdate(patch);
        setIssue((held) => ({ ...held, ...patch }));
      }}
    />
  );
};

/** Renders the open palette over an issue page. */
const renderPalette = (overrides: Partial<IssueRead> = {}): void => {
  render(
    <MemoryRouter initialEntries={['/w/mine']}>
      <ShortcutProvider>
        <Page start={{ ...baseIssue, ...overrides }} />
        <CommandPalette
          open
          onClose={onClose}
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

/** The row of a value in the open sub-page. */
const row = (name: RegExp): HTMLElement => screen.getByRole('option', { name });

beforeEach(() => {
  onUpdate = vi.fn<(patch: IssueUpdate) => void>();
  onClose = vi.fn<() => void>();
});

describe('the label list in the command palette', () => {
  it('toggles several labels without closing', async () => {
    const user = userEvent.setup();
    renderPalette();

    await openSubPage(user, /Change labels…/);
    await user.click(row(/Infra/));

    expect(onUpdate).toHaveBeenLastCalledWith({ label_ids: ['lb-1', 'lb-2'] });
    await waitFor(() => {
      expect(row(/Infra/)).toHaveAttribute('aria-checked', 'true');
    });
    expect(screen.getByTestId('palette-breadcrumb')).toBeInTheDocument();

    await user.click(row(/Bug/));

    expect(onUpdate).toHaveBeenLastCalledWith({ label_ids: ['lb-2'] });
    await waitFor(() => {
      expect(row(/Bug/)).toHaveAttribute('aria-checked', 'false');
    });
    expect(row(/Infra/)).toHaveAttribute('aria-checked', 'true');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clears the term after a toggle and keeps the toggled row active', async () => {
    const user = userEvent.setup();
    renderPalette();

    await openSubPage(user, /Change labels…/);
    await user.type(input(), 'docs');
    await user.keyboard('{Enter}');

    expect(onUpdate).toHaveBeenLastCalledWith({ label_ids: ['lb-1', 'lb-3'] });
    expect(input()).toHaveValue('');
    await waitFor(() => {
      expect(screen.getAllByRole('option')).toHaveLength(3);
    });
    await waitFor(() => {
      expect(row(/Docs/)).toHaveAttribute('aria-selected', 'true');
    });
    expect(row(/Docs/)).toHaveAttribute('aria-checked', 'true');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape and goes back on Backspace with an empty term', async () => {
    const user = userEvent.setup();
    renderPalette();

    await openSubPage(user, /Change labels…/);
    await user.click(row(/Infra/));
    await user.keyboard('{Backspace}');

    expect(screen.queryByTestId('palette-breadcrumb')).toBeNull();

    await openSubPage(user, /Change labels…/);
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });
});

describe('the milestone list in the command palette', () => {
  it("lists the project's milestones with the current one checked", async () => {
    const user = userEvent.setup();
    renderPalette({ project_id: 'pr-1', project_milestone_id: 'ms-1' });

    await openSubPage(user, /Set milestone…/);

    expect(screen.getByTestId('palette-breadcrumb')).toHaveTextContent(
      'Set milestone'
    );
    expect(input()).toHaveAttribute('placeholder', 'Set milestone to…');
    expect(
      screen.getAllByRole('option').map((item) => item.textContent)
    ).toEqual(['No milestone', 'Alpha', 'Beta']);
    expect(row(/Alpha/)).toHaveAttribute('aria-checked', 'true');

    await user.click(row(/Beta/));

    expect(onClose).toHaveBeenCalled();
    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({ project_milestone_id: 'ms-2' });
    });
  });

  it('offers no milestone list for an issue outside a project', async () => {
    renderPalette();

    await screen.findByRole('option', { name: /Change labels…/ });
    expect(screen.queryByRole('option', { name: /Set milestone…/ })).toBeNull();
  });

  it('offers a typed milestone name at the top level', async () => {
    const user = userEvent.setup();
    renderPalette({ project_id: 'pr-1' });

    await user.type(input(), 'beta');

    const group = screen.getByRole('group', { name: 'Change property' });
    await user.click(
      within(group).getByRole('option', { name: /Set milestone to Beta/ })
    );

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({ project_milestone_id: 'ms-2' });
    });
  });
});

describe('the due date list in the command palette', () => {
  it('lists the date presets and sets the one picked', async () => {
    const user = userEvent.setup();
    renderPalette();
    const tomorrow = datePresets(new Date()).find(
      (preset) => preset.label === 'Tomorrow'
    );

    await openSubPage(user, /Set due date…/);

    const names = screen.getAllByRole('option').map((item) => item.textContent);
    expect(names.some((name) => name.startsWith('Tomorrow'))).toBe(true);
    expect(names.some((name) => name.startsWith('End of this week'))).toBe(
      true
    );
    expect(names.some((name) => name.startsWith('Remove due date'))).toBe(
      false
    );

    await user.click(row(/^Tomorrow/));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({ due_date: tomorrow?.value });
    });
  });

  it('leads with the day a typed date names', async () => {
    const user = userEvent.setup();
    renderPalette();
    const typed = typedDateOption('nov 3', new Date());

    await openSubPage(user, /Set due date…/);
    await user.type(input(), 'nov 3');

    expect(input()).toHaveValue('nov 3');
    await waitFor(() => {
      expect(
        screen.getAllByRole('option').map((item) => item.textContent)
      ).toContain(typed?.label);
    });
    expect(screen.getAllByRole('option')[0]).toHaveTextContent(
      typed?.label ?? ''
    );
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({ due_date: typed?.value });
    });
  });

  it('removes a due date the issue has', async () => {
    const user = userEvent.setup();
    renderPalette({ due_date: '2030-01-15' });

    await openSubPage(user, /Set due date…/);
    await user.click(row(/Remove due date/));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({ due_date: null });
    });
  });
});
