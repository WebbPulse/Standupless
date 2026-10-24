/**
 * The project overview's progress panel. Covers that it draws the graph from
 * the issues once they have all been read, gives way to a note while they
 * have not, lists each milestone's share done as a way into its issues, and
 * leads with the latest update when there is one, and splits the stage list
 * per status. Progress reads in estimate points when a team on the project
 * estimates and in issues otherwise, and a toggle switches the numbers, the
 * graph and the projection between the two, remembered per project.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_MEASURE_STORAGE_PREFIX } from '../../lib/projectMeasure';
import type {
  IssueRead,
  MilestoneRead,
  ProjectHistoryRead,
  ProjectRead,
  ProjectUpdateRead,
  StatusRead,
  TeamRead,
} from '../../types/Api';
import ProjectProgressPanel from './ProjectProgressPanel';

const statuses: StatusRead[] = [
  { id: 'todo', name: 'Todo', category: 'unstarted', position: 0 },
  { id: 'done', name: 'Done', category: 'completed', position: 1 },
];

const issue = (id: string, statusId: string): IssueRead => ({
  id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${id}`,
  number: 1,
  title: id,
  body: null,
  status_id: statusId,
  priority: 'none',
  assignee_id: null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: null,
  project_id: 'prj-1',
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-09-20T09:00:00Z',
  updated_at: '2026-09-22T09:00:00Z',
});

const project: ProjectRead = {
  project_id: 'prj-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  team_ids: ['team-1'],
  lead_id: null,
  start_date: '2026-09-18',
  name: 'Launch',
  description: null,
  target_date: '2026-10-01',
  status: 'in_progress',
  icon: null,
  color: null,
  health: null,
  priority: 'none',
  member_ids: [],
  counts: { todo: 1, in_progress: 0, done: 1, cancelled: 0, total: 2 },
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
};

const alpha: MilestoneRead = {
  milestone_id: 'ms-1',
  workspace_id: 'ws-1',
  project_id: 'prj-1',
  name: 'Alpha',
  description: null,
  target_date: null,
  sort_order: 'a0',
  counts: { todo: 1, in_progress: 0, done: 3, cancelled: 0, total: 4 },
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
};

const workflow: StatusRead[] = [
  ...statuses,
  { id: 'review', name: 'In Review', category: 'started', position: 3 },
  { id: 'doing', name: 'In Progress', category: 'started', position: 2 },
];

const stageRows = (): string[] =>
  within(screen.getByRole('list', { name: 'Issues by status' }))
    .getAllByRole('listitem')
    .map((row) => row.textContent);

const stat = (label: string): HTMLElement => {
  const term = screen.getByText(label, { selector: 'dt' });
  const cell = term.parentElement;
  if (cell === null) throw new Error(`No stat named ${label}`);
  return cell;
};

const estimating: TeamRead = {
  id: 'team-1',
  workspace_id: 'ws-1',
  name: 'Engineering',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'tshirt',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
};

const pointedProject: ProjectRead = {
  ...project,
  measure: 'points',
  progress: { todo: 5, in_progress: 0, done: 3, cancelled: 0, total: 8 },
};

const sizedIssues = (): IssueRead[] => [
  { ...issue('1', 'todo'), estimate: 'L' },
  { ...issue('2', 'done'), estimate: 'M' },
  issue('3', 'todo'),
];

const measureButton = (name: 'Issues' | 'Points'): HTMLElement =>
  within(screen.getByRole('group', { name: 'Progress measure' })).getByRole(
    'button',
    { name }
  );

beforeEach(() => {
  localStorage.clear();
});

describe('ProjectProgressPanel', () => {
  it('draws the graph once every issue is read', () => {
    render(
      <ProjectProgressPanel
        project={project}
        issues={[issue('1', 'todo'), issue('2', 'done')]}
        statuses={statuses}
        complete
        milestones={[]}
        onOpenMilestone={vi.fn()}
        today="2026-09-26"
      />
    );

    expect(screen.getByTestId('project-progress-graph')).toBeInTheDocument();
    expect(
      screen.getByRole('img', {
        name: /Scope 2, started 1, completed 1 issues as of 2026-09-26/,
      })
    ).toBeInTheDocument();
  });

  it('reads its numbers off the loaded issues so they match the bars', () => {
    render(
      <ProjectProgressPanel
        project={project}
        issues={[issue('1', 'todo'), issue('2', 'done'), issue('3', 'done')]}
        statuses={statuses}
        complete
        milestones={[]}
        onOpenMilestone={vi.fn()}
        today="2026-09-26"
      />
    );

    expect(stat('Scope')).toHaveTextContent('3issues');
    expect(stat('Completed')).toHaveTextContent('267%');
  });

  it('keeps the stored counts while issues are still loading', () => {
    render(
      <ProjectProgressPanel
        project={project}
        issues={[issue('1', 'todo'), issue('2', 'done'), issue('3', 'done')]}
        statuses={statuses}
        complete={false}
        milestones={[]}
        onOpenMilestone={vi.fn()}
        today="2026-09-26"
      />
    );

    expect(stat('Scope')).toHaveTextContent('2issues');
    expect(stat('Completed')).toHaveTextContent('150%');
  });

  it('waits for every issue before drawing the graph', () => {
    render(
      <ProjectProgressPanel
        project={project}
        issues={[issue('1', 'todo')]}
        statuses={statuses}
        complete={false}
        milestones={[]}
        onOpenMilestone={vi.fn()}
        today="2026-09-26"
      />
    );

    expect(screen.queryByTestId('project-progress-graph')).toBeNull();
    expect(
      screen.getByText('The graph draws once every issue has loaded.')
    ).toBeInTheDocument();
  });

  it('opens a milestone from its progress row', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <ProjectProgressPanel
        project={project}
        issues={[]}
        statuses={statuses}
        complete
        milestones={[alpha]}
        onOpenMilestone={onOpen}
        today="2026-09-26"
      />
    );

    const list = screen.getByRole('list', { name: 'Milestone progress' });
    await user.click(
      within(list).getByRole('button', { name: 'Alpha, 75% complete' })
    );

    expect(onOpen).toHaveBeenCalledWith('ms-1');
  });

  it('leads with the latest update and opens the rest', async () => {
    const user = userEvent.setup();
    const onOpenUpdates = vi.fn();
    const latest: ProjectUpdateRead = {
      update_id: 'upd-1',
      project_id: project.project_id,
      workspace_id: project.workspace_id,
      body: 'Beta is **out**',
      health: 'at_risk',
      author_id: 'user-1',
      created_at: '2026-09-25T00:00:00Z',
      updated_at: '2026-09-25T00:00:00Z',
      edited_at: null,
      can_edit: true,
    };
    render(
      <ProjectProgressPanel
        project={project}
        issues={[]}
        statuses={statuses}
        complete
        milestones={[]}
        onOpenMilestone={vi.fn()}
        latestUpdate={latest}
        latestAuthor="Ada Lovelace"
        onOpenUpdates={onOpenUpdates}
      />
    );

    const section = screen.getByRole('region', { name: 'Latest update' });
    expect(within(section).getByText('At risk')).toBeVisible();
    expect(within(section).getByText('Ada Lovelace')).toBeVisible();
    expect(within(section).getByText('out')).toBeVisible();
    await user.click(
      within(section).getByRole('button', { name: 'See all updates' })
    );
    expect(onOpenUpdates).toHaveBeenCalled();
  });

  it('leaves the latest update out when there is none', () => {
    render(
      <ProjectProgressPanel
        project={project}
        issues={[]}
        statuses={statuses}
        complete
        milestones={[]}
        onOpenMilestone={vi.fn()}
      />
    );

    expect(screen.queryByRole('region', { name: 'Latest update' })).toBeNull();
  });

  it('splits the stage list per status from the loaded issues', () => {
    render(
      <ProjectProgressPanel
        project={project}
        issues={[
          issue('1', 'todo'),
          issue('2', 'review'),
          issue('3', 'doing'),
          issue('4', 'review'),
          issue('5', 'done'),
        ]}
        statuses={workflow}
        complete
        milestones={[]}
        onOpenMilestone={vi.fn()}
        today="2026-09-26"
      />
    );

    expect(stageRows()).toEqual([
      'In Progress1',
      'In Review2',
      'Todo1',
      'Done1',
    ]);
    const segments = screen
      .getByTestId('project-status-bar')
      .querySelectorAll('[data-status]');
    expect(
      [...segments].map((segment) => segment.getAttribute('data-status'))
    ).toEqual(['In Progress', 'In Review', 'Todo', 'Done']);
    expect(segments[1]).toHaveStyle({ width: '40%' });
  });

  it('reads the stored per-status counts while issues are loading', () => {
    render(
      <ProjectProgressPanel
        project={{
          ...project,
          counts: { todo: 0, in_progress: 3, done: 0, cancelled: 0, total: 3 },
          status_counts: { review: 2, doing: 1 },
        }}
        issues={[]}
        statuses={workflow}
        complete={false}
        milestones={[]}
        onOpenMilestone={vi.fn()}
        today="2026-09-26"
      />
    );

    expect(stageRows()).toEqual(['In Progress1', 'In Review2']);
  });

  it('falls back to a row per category without per-status counts', () => {
    render(
      <ProjectProgressPanel
        project={project}
        issues={[]}
        statuses={workflow}
        complete={false}
        milestones={[]}
        onOpenMilestone={vi.fn()}
        today="2026-09-26"
      />
    );

    expect(stageRows()).toEqual([
      'In progress0',
      'Todo1',
      'Backlog0',
      'Done1',
      'Canceled0',
    ]);
    expect(screen.queryByTestId('project-status-bar')).toBeNull();
  });

  it('measures scope and the graph in points when the team estimates', () => {
    const team: TeamRead = {
      id: 'team-1',
      workspace_id: 'ws-1',
      name: 'Engineering',
      key_prefix: 'ENG',
      description: null,
      estimate_scale: 'tshirt',
      created_at: '2026-09-01T00:00:00Z',
      updated_at: '2026-09-01T00:00:00Z',
    };
    const pointed: ProjectRead = {
      ...project,
      measure: 'points',
      progress: { todo: 5, in_progress: 0, done: 3, cancelled: 0, total: 8 },
    };
    render(
      <ProjectProgressPanel
        project={pointed}
        teams={[team]}
        issues={[
          { ...issue('1', 'todo'), estimate: 'L' },
          { ...issue('2', 'done'), estimate: 'M' },
          issue('3', 'todo'),
        ]}
        statuses={statuses}
        complete
        milestones={[]}
        onOpenMilestone={vi.fn()}
        today="2026-09-26"
      />
    );

    expect(stat('Scope')).toHaveTextContent('8points');
    expect(stat('Completed')).toHaveTextContent('338%');
    expect(
      screen.getByRole('img', {
        name: /Scope 8, started 3, completed 3 points as of 2026-09-26/,
      })
    ).toBeInTheDocument();
  });

  it('reads stored points before the issues load', () => {
    render(
      <ProjectProgressPanel
        project={{
          ...project,
          measure: 'points',
          progress: {
            todo: 1,
            in_progress: 0,
            done: 1,
            cancelled: 0,
            total: 2,
          },
        }}
        issues={[]}
        statuses={statuses}
        complete={false}
        milestones={[]}
        onOpenMilestone={vi.fn()}
      />
    );

    expect(stat('Scope')).toHaveTextContent('2points');
  });

  it('draws the recorded history with its projection against the target', () => {
    const history: ProjectHistoryRead = {
      project_id: 'prj-1',
      start_date: '2026-09-22',
      target_date: '2026-10-01',
      today: '2026-09-26',
      measure: 'issues',
      recorded_since: '2026-09-23',
      days: [22, 23, 24, 25, 26].map((day) => ({
        date: `2026-09-${String(day)}`,
        scope: 6,
        started: day - 22,
        completed: day - 22,
        scope_points: 0,
        started_points: 0,
        completed_points: 0,
      })),
      projection: {
        rate_per_day: 1,
        expected_date: '2026-09-28',
        days_past_target: -3,
      },
    };
    render(
      <ProjectProgressPanel
        project={project}
        issues={[]}
        statuses={statuses}
        complete={false}
        milestones={[]}
        onOpenMilestone={vi.fn()}
        today="2026-09-26"
        history={history}
      />
    );

    expect(screen.getByTestId('project-progress-graph')).toBeInTheDocument();
    expect(
      screen.getByRole('img', {
        name: /Scope 6, started 4, completed 4 issues as of 2026-09-26/,
      })
    ).toBeInTheDocument();
    expect(screen.getByTestId('burn-up-forecast')).toBeInTheDocument();
    expect(screen.getByTestId('burn-up-target')).toBeInTheDocument();
    expect(screen.getByTestId('project-projection')).toHaveTextContent(
      /3 days before the target\.$/
    );
  });

  it('falls back to the issues while the history has nothing recorded', () => {
    render(
      <ProjectProgressPanel
        project={project}
        issues={[issue('1', 'todo'), issue('2', 'done')]}
        statuses={statuses}
        complete
        milestones={[]}
        onOpenMilestone={vi.fn()}
        today="2026-09-26"
        history={{
          project_id: 'prj-1',
          start_date: '2026-09-26',
          target_date: '2026-10-01',
          today: '2026-09-26',
          measure: 'issues',
          recorded_since: null,
          days: [],
          projection: null,
        }}
      />
    );

    expect(screen.getByTestId('project-progress-graph')).toBeInTheDocument();
    expect(screen.queryByTestId('burn-up-forecast')).toBeNull();
    expect(screen.queryByTestId('project-projection')).toBeNull();
  });

  it('switches the numbers and the graph between points and issues', async () => {
    render(
      <ProjectProgressPanel
        project={pointedProject}
        teams={[estimating]}
        issues={sizedIssues()}
        statuses={statuses}
        complete
        milestones={[]}
        onOpenMilestone={vi.fn()}
        today="2026-09-26"
      />
    );

    expect(measureButton('Points')).toHaveAttribute('aria-pressed', 'true');
    expect(stat('Scope')).toHaveTextContent('8points');

    await userEvent.click(measureButton('Issues'));

    expect(measureButton('Issues')).toHaveAttribute('aria-pressed', 'true');
    expect(stat('Scope')).toHaveTextContent('3issues');
    expect(stat('Completed')).toHaveTextContent('133%');
    expect(
      screen.getByRole('img', {
        name: /Scope 3, started 1, completed 1 issues as of 2026-09-26/,
      })
    ).toBeInTheDocument();
    expect(localStorage.getItem(`${PROJECT_MEASURE_STORAGE_PREFIX}prj-1`)).toBe(
      'issues'
    );
  });

  it('opens on the measure last chosen for the project', () => {
    localStorage.setItem(`${PROJECT_MEASURE_STORAGE_PREFIX}prj-1`, 'issues');
    render(
      <ProjectProgressPanel
        project={pointedProject}
        teams={[estimating]}
        issues={[]}
        statuses={statuses}
        complete={false}
        milestones={[]}
        onOpenMilestone={vi.fn()}
      />
    );

    expect(measureButton('Issues')).toHaveAttribute('aria-pressed', 'true');
    expect(stat('Scope')).toHaveTextContent('2issues');
  });

  it('disables Points and says why when no team estimates', async () => {
    localStorage.setItem(`${PROJECT_MEASURE_STORAGE_PREFIX}prj-1`, 'points');
    render(
      <ProjectProgressPanel
        project={project}
        issues={[issue('1', 'todo'), issue('2', 'done')]}
        statuses={statuses}
        complete
        milestones={[]}
        onOpenMilestone={vi.fn()}
        today="2026-09-26"
      />
    );

    const points = measureButton('Points');
    expect(points).toHaveAttribute('aria-disabled', 'true');
    expect(points).toHaveAccessibleDescription(
      'No team on this project uses estimates, so progress reads in issues.'
    );
    expect(measureButton('Issues')).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(points);

    expect(points).toHaveAttribute('aria-pressed', 'false');
    expect(stat('Scope')).toHaveTextContent('2issues');
  });

  it('reads the recorded history and its projection in the measure shown', async () => {
    const history: ProjectHistoryRead = {
      project_id: 'prj-1',
      start_date: '2026-09-22',
      target_date: '2026-10-01',
      today: '2026-09-26',
      measure: 'points',
      recorded_since: '2026-09-23',
      days: [22, 23, 24, 25, 26].map((day) => ({
        date: `2026-09-${String(day)}`,
        scope: 6,
        started: Math.floor((day - 22) / 2),
        completed: Math.floor((day - 22) / 2),
        scope_points: 12,
        started_points: (day - 22) * 2,
        completed_points: (day - 22) * 2,
      })),
      projection: {
        rate_per_day: 2,
        expected_date: '2026-09-28',
        days_past_target: -3,
      },
    };
    render(
      <ProjectProgressPanel
        project={pointedProject}
        teams={[estimating]}
        issues={[]}
        statuses={statuses}
        complete={false}
        milestones={[]}
        onOpenMilestone={vi.fn()}
        today="2026-09-26"
        history={history}
      />
    );

    expect(
      screen.getByRole('img', {
        name: /Scope 12, started 8, completed 8 points as of 2026-09-26/,
      })
    ).toBeInTheDocument();
    expect(screen.getByTestId('project-projection')).toHaveTextContent(
      /3 days before the target\.$/
    );

    await userEvent.click(measureButton('Issues'));

    expect(
      screen.getByRole('img', {
        name: /Scope 6, started 2, completed 2 issues as of 2026-09-26/,
      })
    ).toBeInTheDocument();
    expect(screen.getByTestId('project-projection')).toHaveTextContent(
      /after the target\.$/
    );
  });
});
