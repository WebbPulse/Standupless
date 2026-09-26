/**
 * The cycle and project pickers on an issue. Covers that both offer only the
 * issue's own team's rows, that clearing one sends null rather than an empty
 * string, and that a role without write access is offered no change at all.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CycleListRead,
  IssueRead,
  IssueUpdate,
  ProjectListRead,
  RollupCounts,
} from '../../types/Api';
import PlanningPickers from './PlanningPickers';

const listCycles = vi.fn<(query: unknown) => Promise<CycleListRead>>();
const listProjects = vi.fn<(query: unknown) => Promise<ProjectListRead>>();
const updateIssue =
  vi.fn<(id: string, body: IssueUpdate) => Promise<IssueRead>>();

vi.mock('../../api/planning', () => ({
  listCycles: (_w: string, query: unknown) => listCycles(query),
  listProjects: (_w: string, query: unknown) => listProjects(query),
}));

vi.mock('../../api/issues', () => ({
  updateIssue: (_w: string, id: string, body: IssueUpdate) =>
    updateIssue(id, body),
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

const counts: RollupCounts = {
  todo: 0,
  in_progress: 0,
  done: 0,
  cancelled: 0,
  total: 0,
};

const issue: IssueRead = {
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'proj-1',
  key: 'ENG-1',
  number: 1,
  title: 'Boot the engine',
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
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
};

const onSaved = vi.fn<(saved: IssueRead) => void>();

const renderPickers = (over: Partial<IssueRead> = {}, canEdit = true) =>
  render(
    <PlanningPickers
      workspaceId="ws-1"
      teamId="proj-1"
      issue={{ ...issue, ...over }}
      canEdit={canEdit}
      onSaved={onSaved}
    />
  );

beforeEach(() => {
  listCycles.mockReset();
  listProjects.mockReset();
  updateIssue.mockReset();
  onSaved.mockReset();
  listCycles.mockResolvedValue({
    cycles: [
      {
        cycle_id: 'cyc-1',
        workspace_id: 'ws-1',
        team_id: 'proj-1',
        name: 'Sprint 1',
        start_date: '2026-09-01',
        end_date: '2026-09-14',
        goal: null,
        cancelled: false,
        status: 'active',
        counts,
        created_by: 'user-1',
        created_at: '2026-09-18T00:00:00Z',
        updated_at: '2026-09-18T00:00:00Z',
      },
    ],
    next_cursor: null,
  });
  listProjects.mockResolvedValue({
    projects: [
      {
        project_id: 'mil-1',
        workspace_id: 'ws-1',
        team_id: 'proj-1',
        name: 'Public beta',
        description: null,
        target_date: '2026-10-01',
        status: 'planned',
        counts,
        created_by: 'user-1',
        created_at: '2026-09-18T00:00:00Z',
        updated_at: '2026-09-18T00:00:00Z',
      },
    ],
    next_cursor: null,
  });
  updateIssue.mockImplementation((_id, body) =>
    Promise.resolve({ ...issue, ...body })
  );
});

describe('the choices offered', () => {
  it('reads both lists under the issue own team', async () => {
    renderPickers();

    await waitFor(() => {
      expect(listCycles).toHaveBeenCalledWith({ team_id: 'proj-1' });
      expect(listProjects).toHaveBeenCalledWith({ team_id: 'proj-1' });
    });
  });

  it('offers each cycle with the status the server derived', async () => {
    renderPickers();

    expect(
      await screen.findByRole('option', { name: 'Sprint 1 (Active)' })
    ).toBeInTheDocument();
  });

  it('offers each team with the status the server stored', async () => {
    renderPickers();

    expect(
      await screen.findByRole('option', { name: 'Public beta (Planned)' })
    ).toBeInTheDocument();
  });

  it('offers an explicit no cycle and no project choice', async () => {
    renderPickers();

    expect(
      await screen.findByRole('option', { name: 'No cycle' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'No project' })
    ).toBeInTheDocument();
  });
});

describe('attaching and clearing', () => {
  it('attaches a cycle by id', async () => {
    renderPickers();
    await screen.findByRole('option', { name: 'Sprint 1 (Active)' });

    await userEvent.selectOptions(screen.getByLabelText('Cycle'), 'cyc-1');

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', {
        cycle_id: 'cyc-1',
      });
    });
  });

  it('attaches a project by id', async () => {
    renderPickers();
    await screen.findByRole('option', { name: 'Public beta (Planned)' });

    await userEvent.selectOptions(screen.getByLabelText('Project'), 'mil-1');

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', {
        project_id: 'mil-1',
      });
    });
  });

  it('clears with null rather than an empty string', async () => {
    renderPickers({ cycle_id: 'cyc-1' });
    await screen.findByRole('option', { name: 'Sprint 1 (Active)' });

    await userEvent.selectOptions(screen.getByLabelText('Cycle'), '');

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', { cycle_id: null });
    });
  });

  it('hands the saved issue back so the page redraws from the server', async () => {
    renderPickers();
    await screen.findByRole('option', { name: 'Sprint 1 (Active)' });

    await userEvent.selectOptions(screen.getByLabelText('Cycle'), 'cyc-1');

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(
        expect.objectContaining({ cycle_id: 'cyc-1' })
      );
    });
  });

  it('shows the refusal when the server rejects the attachment', async () => {
    updateIssue.mockRejectedValue(new Error('nope'));

    renderPickers();
    await screen.findByRole('option', { name: 'Sprint 1 (Active)' });

    await userEvent.selectOptions(screen.getByLabelText('Cycle'), 'cyc-1');

    expect(
      await screen.findByText('Could not save that change.')
    ).toBeInTheDocument();
  });
});

describe('what a role is offered', () => {
  it('locks both pickers without write access', async () => {
    renderPickers({}, false);

    await waitFor(() => {
      expect(screen.getByLabelText('Cycle')).toBeDisabled();
    });
    expect(screen.getByLabelText('Project')).toBeDisabled();
  });
});
