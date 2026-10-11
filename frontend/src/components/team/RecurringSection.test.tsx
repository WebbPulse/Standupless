/**
 * The recurring issues section. Covers a schedule reading as its rule, its
 * next run and its last issue; a paused one saying why and offering resume;
 * a new weekly schedule sending only the fields its frequency reads; "Make
 * recurring" opening the form on that template; and a reader seeing no
 * controls.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RecurringIssueCreate,
  RecurringIssueListRead,
  RecurringIssueRead,
  RecurringIssueUpdate,
  TemplateRead,
} from '../../types/Api';
import RecurringSection, { describeRule } from './RecurringSection';

const listRecurringIssues = vi.fn<() => Promise<RecurringIssueListRead>>();
const createRecurringIssue =
  vi.fn<(body: RecurringIssueCreate) => Promise<RecurringIssueRead>>();
const updateRecurringIssue =
  vi.fn<
    (id: string, body: RecurringIssueUpdate) => Promise<RecurringIssueRead>
  >();
const deleteRecurringIssue = vi.fn<(id: string) => Promise<void>>();

vi.mock('../../api/recurring', () => ({
  listRecurringIssues: () => listRecurringIssues(),
  createRecurringIssue: (_w: string, _t: string, body: RecurringIssueCreate) =>
    createRecurringIssue(body),
  updateRecurringIssue: (
    _w: string,
    _t: string,
    id: string,
    body: RecurringIssueUpdate
  ) => updateRecurringIssue(id, body),
  deleteRecurringIssue: (_w: string, _t: string, id: string) =>
    deleteRecurringIssue(id),
}));

vi.mock('../../api/templates', () => ({
  listTeamTemplates: () =>
    Promise.resolve({
      templates: [template('tp-1', 'Daily triage'), template('tp-2', 'Retro')],
      default_template_id: null,
    }),
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

/** A team template with a name. */
function template(id: string, name: string): TemplateRead {
  return {
    id,
    name,
    team_id: 'team-1',
    scope: 'team',
    title: null,
    body: null,
    status_id: null,
    priority: null,
    assignee_id: null,
    label_ids: [],
    estimate: null,
    project_id: null,
    project_milestone_id: null,
    cycle_id: null,
    position: 0,
    created_by: 'user-1',
    created_at: '2026-10-10T00:00:00Z',
    updated_at: '2026-10-10T00:00:00Z',
  };
}

/** A schedule as the list answers it, each test changing what it needs. */
const schedule = (
  over: Partial<RecurringIssueRead> = {}
): RecurringIssueRead => ({
  id: 'rc-1',
  team_id: 'team-1',
  template_id: 'tp-1',
  template_name: 'Daily triage',
  frequency: 'weekly',
  interval: 2,
  weekdays: [4, 0],
  day_of_month: null,
  time: '09:30',
  timezone: 'Europe/Paris',
  starts_on: '2026-10-01',
  paused: false,
  paused_reason: null,
  next_run_at: '2026-10-12T07:30:00Z',
  upcoming_runs: ['2026-10-16T07:30:00Z'],
  last_run_at: '2026-10-09T07:30:00Z',
  last_issue_id: 'iss-1',
  last_issue_key: 'ENG-42',
  created_by: 'user-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
});

const answer = (rows: RecurringIssueRead[]): RecurringIssueListRead => ({
  recurring_issues: rows,
  default_timezone: 'America/New_York',
});

beforeEach(() => {
  listRecurringIssues.mockReset();
  createRecurringIssue.mockReset();
  updateRecurringIssue.mockReset();
  deleteRecurringIssue.mockReset();
  createRecurringIssue.mockResolvedValue(schedule());
  updateRecurringIssue.mockResolvedValue(schedule());
  deleteRecurringIssue.mockResolvedValue(undefined);
});

describe('describeRule', () => {
  it('says the frequency, interval, days and local time', () => {
    expect(describeRule(schedule())).toBe(
      'Every 2 weeks on Mon, Fri at 09:30 Europe/Paris'
    );
    expect(
      describeRule(
        schedule({ frequency: 'daily', interval: 1, weekdays: [] })
      )
    ).toBe('Every day at 09:30 Europe/Paris');
    expect(
      describeRule(
        schedule({ frequency: 'monthly', interval: 1, day_of_month: 31 })
      )
    ).toBe('Every month on day 31 at 09:30 Europe/Paris');
  });
});

describe('the recurring issues section', () => {
  it('lists a schedule with its rule, next run and last issue', async () => {
    listRecurringIssues.mockResolvedValue(answer([schedule()]));
    render(<RecurringSection workspaceId="ws-1" teamId="team-1" canEdit />);

    const list = await screen.findByRole('list', { name: 'Recurring issues' });
    expect(within(list).getByText('Daily triage')).toBeInTheDocument();
    expect(
      within(list).getByText('Every 2 weeks on Mon, Fri at 09:30 Europe/Paris')
    ).toBeInTheDocument();
    expect(list.querySelector('time')).toHaveAttribute(
      'dateTime',
      '2026-10-12T07:30:00Z'
    );
    expect(list).toHaveTextContent('created within the hour after');
    expect(list).toHaveTextContent('Last ENG-42');
  });

  it('shows why the system paused a schedule and resumes it', async () => {
    const user = userEvent.setup();
    listRecurringIssues.mockResolvedValue(
      answer([
        schedule({
          paused: true,
          paused_reason: 'template_deleted',
          template_name: null,
          next_run_at: null,
          upcoming_runs: [],
        }),
      ])
    );
    render(<RecurringSection workspaceId="ws-1" teamId="team-1" canEdit />);

    expect(
      await screen.findByText('Paused: Template deleted')
    ).toBeInTheDocument();
    expect(screen.getByText(/No next run while paused/)).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Resume Deleted template' })
    );

    await waitFor(() => {
      expect(updateRecurringIssue).toHaveBeenCalledWith('rc-1', {
        paused: false,
      });
    });
  });

  it('creates a weekly schedule in the team timezone', async () => {
    const user = userEvent.setup();
    listRecurringIssues.mockResolvedValue(answer([]));
    render(<RecurringSection workspaceId="ws-1" teamId="team-1" canEdit />);

    const add = await screen.findByRole('button', {
      name: 'New recurring issue',
    });
    await waitFor(() => {
      expect(add).toBeEnabled();
    });
    await user.click(add);
    const form = screen.getByRole('form', { name: 'Create schedule' });
    await user.selectOptions(within(form).getByLabelText('Template'), 'tp-2');
    await user.selectOptions(within(form).getByLabelText('Repeats'), 'weekly');
    for (const day of within(form).getAllByRole('button', { pressed: true })) {
      await user.click(day);
    }
    await user.click(within(form).getByRole('button', { name: 'Tuesday' }));
    await user.click(within(form).getByRole('button', { name: 'Thursday' }));
    await user.click(
      within(form).getByRole('button', { name: 'Create schedule' })
    );

    await waitFor(() => {
      expect(createRecurringIssue).toHaveBeenCalledWith({
        template_id: 'tp-2',
        frequency: 'weekly',
        interval: 1,
        weekdays: [1, 3],
        day_of_month: null,
        time: '09:00',
        timezone: 'America/New_York',
      });
    });
  });

  it('opens the form on a template from make recurring, and Escape closes it', async () => {
    const user = userEvent.setup();
    listRecurringIssues.mockResolvedValue(answer([]));
    render(
      <RecurringSection
        workspaceId="ws-1"
        teamId="team-1"
        canEdit
        initialTemplateId="tp-2"
      />
    );

    const form = await screen.findByRole('form', { name: 'Create schedule' });
    expect(within(form).getByLabelText('Template')).toHaveValue('tp-2');
    await user.keyboard('{Escape}');
    expect(
      screen.queryByRole('form', { name: 'Create schedule' })
    ).not.toBeInTheDocument();
  });

  it('asks before deleting', async () => {
    const user = userEvent.setup();
    listRecurringIssues.mockResolvedValue(answer([schedule()]));
    render(<RecurringSection workspaceId="ws-1" teamId="team-1" canEdit />);

    await user.click(
      await screen.findByRole('button', {
        name: 'Delete Daily triage schedule',
      })
    );
    const confirm = screen.getByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(deleteRecurringIssue).toHaveBeenCalledWith('rc-1');
    });
  });

  it('shows a reader no controls', async () => {
    listRecurringIssues.mockResolvedValue(answer([schedule()]));
    render(
      <RecurringSection workspaceId="ws-1" teamId="team-1" canEdit={false} />
    );

    expect(await screen.findByText('Daily triage')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Pause Daily triage' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'New recurring issue' })
    ).not.toBeInTheDocument();
  });
});
