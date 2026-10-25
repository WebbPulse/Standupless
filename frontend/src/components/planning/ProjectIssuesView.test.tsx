/**
 * The "Show triage issues" switch on a project's issues: off by default so
 * the list asks for no triage issues, on sends `include_triage`, the choice is
 * remembered per project in this browser, and the reset turns it back off.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueListFilters } from '../../api/issues';
import type { IssueCollection } from '../../hooks/useIssueCollection';
import type { IssueContextState } from '../../hooks/useIssueContext';
import type { IssueContext } from '../../lib/issueView';
import {
  PROJECT_TRIAGE_STORAGE_PREFIX,
  readProjectShowTriage,
} from '../../lib/projectTriage';
import ProjectIssuesView from './ProjectIssuesView';

const queries = vi.hoisted(() => [] as IssueListFilters[]);

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('../../hooks/useIssueCollection', () => ({
  useIssueCollection: (
    _workspaceId: string,
    _scope: string,
    query: IssueListFilters
  ): IssueCollection => {
    queries.push(query);
    return { issues: [], isLoading: false } as unknown as IssueCollection;
  },
}));

vi.mock('../../hooks/useIssueContext', () => {
  const context: IssueContext = {
    statuses: [],
    labels: [],
    people: [],
    projects: [],
    cycles: [],
  };
  const state = {
    context,
    forTeam: () => context,
    isLoading: false,
    createLabel: () => Promise.resolve(null),
  } as IssueContextState;
  return { useIssueContext: () => state };
});

vi.mock('../issues/view/IssueListView', () => ({
  default: () => <div data-testid="issue-list" />,
}));

const renderView = (projectId = 'project-1'): void => {
  render(
    <MemoryRouter>
      <ProjectIssuesView
        workspaceId="ws-1"
        slug="acme"
        projectId={projectId}
        teams={[]}
        milestones={[]}
        canEdit
      />
    </MemoryRouter>
  );
};

const lastQuery = (): IssueListFilters | undefined => queries.at(-1);

beforeEach(() => {
  localStorage.clear();
  queries.length = 0;
});

describe('ProjectIssuesView triage switch', () => {
  it('is off by default and asks for no triage issues', async () => {
    const user = userEvent.setup();
    renderView();

    expect(lastQuery()).toMatchObject({ project_id: 'project-1' });
    expect(lastQuery()).not.toHaveProperty('include_triage');

    await user.click(screen.getByRole('button', { name: 'Display' }));
    const toggle = screen.getByRole('switch', { name: 'Show triage issues' });
    expect(toggle).not.toBeChecked();
  });

  it('sends include_triage once turned on and remembers it per project', async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole('button', { name: 'Display' }));
    await user.click(
      screen.getByRole('switch', { name: 'Show triage issues' })
    );

    expect(lastQuery()).toMatchObject({
      project_id: 'project-1',
      include_triage: true,
    });
    expect(readProjectShowTriage('project-1')).toBe(true);
    expect(readProjectShowTriage('project-2')).toBe(false);
  });

  it('opens with triage shown where this project last had it on', async () => {
    localStorage.setItem(`${PROJECT_TRIAGE_STORAGE_PREFIX}project-1`, '1');
    const user = userEvent.setup();
    renderView();

    expect(lastQuery()).toMatchObject({ include_triage: true });
    await user.click(screen.getByRole('button', { name: 'Display' }));
    expect(
      screen.getByRole('switch', { name: 'Show triage issues' })
    ).toBeChecked();
  });

  it('turns triage back off on reset', async () => {
    localStorage.setItem(`${PROJECT_TRIAGE_STORAGE_PREFIX}project-1`, '1');
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole('button', { name: 'Display' }));
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));

    expect(lastQuery()).not.toHaveProperty('include_triage');
    expect(readProjectShowTriage('project-1')).toBe(false);
  });
});
