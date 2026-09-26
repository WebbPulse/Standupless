/**
 * The cycle and project sections on an issue. Covers that both offer only the
 * issue's own team's rows with the status beside each, that a pick reports a
 * one field patch, that clearing one sends null rather than an empty string,
 * and that a role without write access is offered no change at all.
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

vi.mock('../../api/planning', () => ({
  listCycles: (_w: string, query: unknown) => listCycles(query),
  listProjects: (_w: string, query: unknown) => listProjects(query),
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

const onUpdate = vi.fn<(patch: IssueUpdate) => void>();

const renderPickers = (over: Partial<IssueRead> = {}, canEdit = true) =>
  render(
    <PlanningPickers
      workspaceId="ws-1"
      teamId="proj-1"
      issue={{ ...issue, ...over }}
      canEdit={canEdit}
      onUpdate={onUpdate}
    />
  );

beforeEach(() => {
  listCycles.mockReset();
  listProjects.mockReset();
  onUpdate.mockReset();
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
        project_id: 'prj-1',
        workspace_id: 'ws-1',
        team_id: 'proj-1',
        team_ids: ['proj-1'],
        lead_id: null,
        start_date: null,
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
    const user = userEvent.setup();
    renderPickers();
    await waitFor(() => {
      expect(listCycles).toHaveBeenCalled();
    });

    await user.click(screen.getByRole('button', { name: /^Cycle:/ }));

    const option = await screen.findByRole('option', { name: /Sprint 1/ });
    expect(option).toHaveTextContent('Active');
    expect(
      screen.getByRole('option', { name: 'No cycle' })
    ).toBeInTheDocument();
  });

  it('offers each project with the status the server stored', async () => {
    const user = userEvent.setup();
    renderPickers();
    await waitFor(() => {
      expect(listProjects).toHaveBeenCalled();
    });

    await user.click(screen.getByRole('button', { name: /^Project:/ }));

    const option = await screen.findByRole('option', { name: /Public beta/ });
    expect(option).toHaveTextContent('Planned');
    expect(
      screen.getByRole('option', { name: 'No project' })
    ).toBeInTheDocument();
  });
});

describe('attaching and clearing', () => {
  it('attaches a cycle by id', async () => {
    const user = userEvent.setup();
    renderPickers();
    await user.click(screen.getByRole('button', { name: /^Cycle:/ }));
    await user.click(await screen.findByRole('option', { name: /Sprint 1/ }));

    expect(onUpdate).toHaveBeenCalledWith({ cycle_id: 'cyc-1' });
  });

  it('attaches a project by id from the keyboard', async () => {
    const user = userEvent.setup();
    renderPickers();
    await screen.findByRole('button', { name: /^Project:/ });
    await waitFor(() => {
      expect(listProjects).toHaveBeenCalled();
    });
    screen.getByRole('button', { name: /^Project:/ }).focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('option', { name: /Public beta/ });
    await user.keyboard('beta{Enter}');

    expect(onUpdate).toHaveBeenCalledWith({ project_id: 'prj-1' });
  });

  it('clears with null rather than an empty string', async () => {
    const user = userEvent.setup();
    renderPickers({ cycle_id: 'cyc-1' });
    const trigger = await screen.findByRole('button', {
      name: 'Cycle: Sprint 1',
    });
    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: 'No cycle' }));

    expect(onUpdate).toHaveBeenCalledWith({ cycle_id: null });
  });
});

describe('what a role is offered', () => {
  it('locks both pickers without write access', () => {
    renderPickers({}, false);

    expect(screen.getByRole('button', { name: /^Cycle:/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Project:/ })).toBeDisabled();
  });
});
