/**
 * The project overview's progress panel. Covers that it draws the graph from
 * the issues once they have all been read, gives way to a note while they
 * have not, and lists each milestone's share done as a way into its issues.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  IssueRead,
  MilestoneRead,
  ProjectRead,
  StatusRead,
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
});
