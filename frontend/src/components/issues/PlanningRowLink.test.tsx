/**
 * The link out of an issue's project and milestone rows. Covers that the
 * arrow is a real anchor to the project page, so a modified click can open a
 * new tab, that following it lands on the project, that the picker beside it
 * still opens and picks, and that a row with nothing to open shows no arrow.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { projectMilestonePath, projectPath } from '../../lib/paths';
import type { ProjectRead } from '../../types/Api';
import PlanningRowLink from './PlanningRowLink';
import { ProjectPicker } from './PropertyPickers';

const project = (id: string, name: string): ProjectRead => ({
  project_id: id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  team_ids: ['team-1'],
  lead_id: null,
  start_date: null,
  name,
  description: null,
  target_date: null,
  status: 'planned',
  icon: null,
  color: null,
  health: null,
  priority: 'none',
  member_ids: [],
  counts: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
  created_by: 'user-1',
  created_at: '2026-10-16T00:00:00Z',
  updated_at: '2026-10-16T00:00:00Z',
});

const projects = [project('prj-1', 'Public beta'), project('prj-2', 'Launch')];

const renderRow = (
  value: string | null,
  onChange: (projectId: string | null) => void = vi.fn()
) =>
  render(
    <MemoryRouter initialEntries={['/w/mine/issues/ENG-1']}>
      <Routes>
        <Route
          path="/w/mine/issues/ENG-1"
          element={
            <PlanningRowLink
              to={value === null ? null : projectPath('mine', value)}
              label="Open project"
            >
              <ProjectPicker
                projects={projects}
                value={value}
                onChange={onChange}
              />
            </PlanningRowLink>
          }
        />
        <Route path="/w/mine/projects/:id" element={<p>Project page</p>} />
      </Routes>
    </MemoryRouter>
  );

describe('PlanningRowLink', () => {
  it('links to the project page with a real anchor', () => {
    renderRow('prj-1');

    expect(screen.getByRole('link', { name: 'Open project' })).toHaveAttribute(
      'href',
      '/w/mine/projects/prj-1'
    );
  });

  it('opens the project page on a click', async () => {
    const user = userEvent.setup();
    renderRow('prj-1');

    await user.click(screen.getByRole('link', { name: 'Open project' }));

    expect(await screen.findByText('Project page')).toBeInTheDocument();
  });

  it('keeps the picker opening and picking beside the link', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderRow('prj-1', onChange);

    await user.click(
      screen.getByRole('button', { name: 'Project: Public beta' })
    );
    await user.click(await screen.findByRole('option', { name: /Launch/ }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('prj-2');
    });
    expect(screen.queryByText('Project page')).not.toBeInTheDocument();
  });

  it('shows no link for an issue in no project', () => {
    renderRow(null);

    expect(
      screen.queryByRole('link', { name: 'Open project' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Project: No project' })
    ).toBeInTheDocument();
  });
});

describe('projectMilestonePath', () => {
  it('opens the issues tab filtered to the milestone', () => {
    const url = new URL(
      projectMilestonePath('mine', 'prj-1', 'ms-1'),
      'https://example.test'
    );

    expect(url.pathname).toBe('/w/mine/projects/prj-1');
    expect(url.searchParams.get('tab')).toBe('issues');
    expect(url.searchParams.getAll('f')).toEqual(['milestone.is:ms-1']);
  });
});
