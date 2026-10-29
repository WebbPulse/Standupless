/**
 * The sub-issues section. Covers changing a child's status, priority and
 * assignee from its row, the header count following a status change before
 * the rollup lands, reordering by drag and by Alt+arrow under manual ordering,
 * j and k moving focus and p opening the focused row's picker, hiding
 * completed sub-issues behind an expandable count remembered for the viewer,
 * filing children one after another from the inline row, Escape leaving it, a
 * failed create giving the title back, pasted lines filed in order once
 * confirmed, picked fields kept on Ctrl+Shift+Enter, the parent's priority and
 * project inherited, and a read only caller seeing no controls.
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../../api/issues';
import type { Assignable } from '../../lib/issuePeople';
import { SUB_ISSUE_DISPLAY_KEY } from '../../lib/subIssues';
import type { IssueRead, StatusRead } from '../../types/Api';
import { clearToasts } from '../../lib/toast';
import SubIssues, { type SubIssuesProps } from './SubIssues';

const updateIssue = vi.fn<(id: string, body: unknown) => Promise<IssueRead>>();
const createIssue = vi.fn<(body: unknown) => Promise<IssueRead>>();

vi.mock('../../api/issues', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/issues')>(
      '../../api/issues'
    );
  return {
    ...actual,
    updateIssue: (_w: string, id: string, body: unknown) =>
      updateIssue(id, body),
    createIssue: (_w: string, body: unknown) => createIssue(body),
  };
});

const statuses: StatusRead[] = [
  { id: 'st-1', name: 'Backlog', category: 'backlog', position: 0 },
  { id: 'st-2', name: 'Todo', category: 'unstarted', position: 1 },
  { id: 'st-3', name: 'Doing', category: 'started', position: 2 },
  { id: 'st-4', name: 'Done', category: 'completed', position: 3 },
];

const child = (id: string, title: string, statusId = 'st-2'): IssueRead => ({
  id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${id}`,
  number: 1,
  title,
  body: '',
  status_id: statusId,
  priority: 'none',
  assignee_id: null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: 'p-1',
  cycle_id: null,
  project_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-10-24T00:00:00Z',
  updated_at: '2026-10-24T00:00:00Z',
});

const renderSection = (props: Partial<SubIssuesProps> = {}) =>
  render(
    <MemoryRouter>
      <SubIssues
        workspaceId="ws-1"
        slug="mine"
        parent={{ id: 'p-1', team_id: 'team-1' }}
        rows={[]}
        isLoading={false}
        error={null}
        progress={{ total: 0, completed: 0 }}
        statuses={statuses}
        people={[]}
        canEdit
        {...props}
      />
    </MemoryRouter>
  );

const people: Assignable[] = [
  {
    user_id: 'u-1',
    email: 'olive@example.com',
    display_name: 'Olive Owner',
    avatar_url: null,
  },
];

/** Answers each write with the row it was asked for, changed. */
const echoWrites = (rows: IssueRead[]): void => {
  updateIssue.mockImplementation((id, body) => {
    const row = rows.find((each) => each.id === id);
    return Promise.resolve({
      ...(row as IssueRead),
      ...(body as Partial<IssueRead>),
      updated_at: '2026-10-24T00:00:05Z',
    });
  });
};

/** The rows of the list, in the order they show. */
const shownTitles = (): string[] =>
  within(screen.getByRole('list', { name: 'Sub-issues' }))
    .getAllByRole('link')
    .map((link) => link.textContent ?? '');

const dragData = (): { dataTransfer: Partial<DataTransfer> } => ({
  dataTransfer: { setData: vi.fn(), effectAllowed: 'all', dropEffect: 'none' },
});

beforeEach(() => {
  updateIssue.mockReset();
  createIssue.mockReset();
  clearToasts();
  globalThis.localStorage.clear();
});

describe('changing a sub-issue status', () => {
  it('writes the status picked on the row and counts it at once', async () => {
    const row = child('2', 'A child');
    updateIssue.mockResolvedValue({
      ...row,
      status_id: 'st-4',
      updated_at: '2026-10-24T00:00:01Z',
    });
    const user = userEvent.setup();
    renderSection({ rows: [row], progress: { total: 1, completed: 0 } });

    const section = screen.getByRole('region', { name: 'Sub-issues' });
    expect(within(section).getByText('0/1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Status: Todo' }));
    await user.keyboard('4');

    expect(updateIssue).toHaveBeenCalledWith('2', { status_id: 'st-4' });
    expect(
      screen.getByRole('button', { name: 'Status: Done' })
    ).toBeInTheDocument();
    expect(within(section).getByText('1/1')).toBeInTheDocument();
    expect(screen.getByText('A child').closest('a')).toHaveAttribute(
      'href',
      '/w/mine/issues/ENG-2'
    );
  });

  it('keeps the rollup count while some children are not loaded', () => {
    renderSection({
      rows: [child('2', 'A child', 'st-4')],
      progress: { total: 4, completed: 2 },
    });

    expect(screen.getByText('2/4')).toBeInTheDocument();
  });
});

describe('adding sub-issues inline', () => {
  it('files a child per Enter in the parent team and stays for the next', async () => {
    createIssue
      .mockResolvedValueOnce(child('5', 'First'))
      .mockResolvedValueOnce(child('6', 'Second'));
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Add sub-issue' }));
    const input = screen.getByRole('textbox', { name: 'New sub-issue title' });
    expect(input).toHaveFocus();

    await user.type(input, 'First{Enter}');

    expect(createIssue).toHaveBeenCalledWith({
      team_id: 'team-1',
      title: 'First',
      parent_id: 'p-1',
    });
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(await screen.findByText('First')).toBeInTheDocument();
    expect(screen.getByText('0/1')).toBeInTheDocument();

    await user.type(input, 'Second{Enter}');

    expect(createIssue).toHaveBeenLastCalledWith({
      team_id: 'team-1',
      title: 'Second',
      parent_id: 'p-1',
    });
    expect(await screen.findByText('Second')).toBeInTheDocument();
    expect(screen.getByText('0/2')).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it('leaves the row on Escape without filing anything', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Add sub-issue' }));
    await user.type(
      screen.getByRole('textbox', { name: 'New sub-issue title' }),
      'Half typed{Escape}'
    );

    expect(
      screen.queryByRole('textbox', { name: 'New sub-issue title' })
    ).not.toBeInTheDocument();
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('gives the title back when the create fails', async () => {
    createIssue.mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Add sub-issue' }));
    const input = screen.getByRole('textbox', { name: 'New sub-issue title' });
    await user.type(input, 'Lost{Enter}');

    await waitFor(() => {
      expect(input).toHaveValue('Lost');
    });
  });
});

describe('filing several sub-issues from the inline row', () => {
  it('asks before filing pasted lines, then files them in order', async () => {
    createIssue
      .mockResolvedValueOnce(child('5', 'One'))
      .mockResolvedValueOnce(child('6', 'Two'))
      .mockResolvedValueOnce(child('7', 'Three'));
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Add sub-issue' }));
    const input = screen.getByRole('textbox', { name: 'New sub-issue title' });
    await user.click(input);
    await user.paste('- One\n\n- [ ] Two\n3. Three');

    expect(screen.getByText('Create 3 sub-issues?')).toBeInTheDocument();
    expect(input).toHaveValue('');
    expect(createIssue).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Create 3' }));

    await waitFor(() => {
      expect(createIssue).toHaveBeenCalledTimes(3);
    });
    expect(
      createIssue.mock.calls.map(([body]) => (body as { title: string }).title)
    ).toEqual(['One', 'Two', 'Three']);
    expect(await screen.findByText('Three')).toBeInTheDocument();
  });

  it('pastes a single line as the title without asking', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Add sub-issue' }));
    const input = screen.getByRole('textbox', { name: 'New sub-issue title' });
    await user.click(input);
    await user.paste('Just one');

    expect(input).toHaveValue('Just one');
    expect(screen.queryByText(/sub-issues\?$/)).not.toBeInTheDocument();
  });

  it('keeps the picked priority for the next title on Ctrl+Shift+Enter', async () => {
    createIssue
      .mockResolvedValueOnce(child('5', 'First'))
      .mockResolvedValueOnce(child('6', 'Second'))
      .mockResolvedValueOnce(child('7', 'Third'));
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Add sub-issue' }));
    await user.click(
      screen.getByRole('button', { name: 'Priority: No priority' })
    );
    await user.keyboard('2');
    const input = screen.getByRole('textbox', { name: 'New sub-issue title' });

    await user.type(input, 'First{Control>}{Shift>}{Enter}{/Shift}{/Control}');

    expect(createIssue).toHaveBeenLastCalledWith({
      team_id: 'team-1',
      title: 'First',
      parent_id: 'p-1',
      priority: 'high',
    });
    expect(input).toHaveValue('');

    await user.type(input, 'Second{Enter}');

    expect(createIssue).toHaveBeenLastCalledWith({
      team_id: 'team-1',
      title: 'Second',
      parent_id: 'p-1',
      priority: 'high',
    });

    await user.type(input, 'Third{Enter}');

    expect(createIssue).toHaveBeenLastCalledWith({
      team_id: 'team-1',
      title: 'Third',
      parent_id: 'p-1',
    });
  });

  it("inherits the parent's priority and project", async () => {
    createIssue.mockResolvedValueOnce(child('5', 'First'));
    const user = userEvent.setup();
    renderSection({
      parent: {
        id: 'p-1',
        team_id: 'team-1',
        priority: 'urgent',
        project_id: 'proj-1',
      },
    });

    await user.click(screen.getByRole('button', { name: 'Add sub-issue' }));
    await user.type(
      screen.getByRole('textbox', { name: 'New sub-issue title' }),
      'First{Enter}'
    );

    expect(createIssue).toHaveBeenCalledWith({
      team_id: 'team-1',
      title: 'First',
      parent_id: 'p-1',
      priority: 'urgent',
      project_id: 'proj-1',
    });
  });
});

describe('a read only caller', () => {
  it('sees the rows without the status pickers or the add row', () => {
    renderSection({ rows: [child('2', 'A child')], canEdit: false });

    expect(screen.getByRole('button', { name: 'Status: Todo' })).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Add sub-issue' })
    ).not.toBeInTheDocument();
  });
});

describe('editing a sub-issue in place', () => {
  it('writes the priority picked on the row', async () => {
    const row = child('2', 'A child');
    echoWrites([row]);
    const user = userEvent.setup();
    renderSection({ rows: [row], progress: { total: 1, completed: 0 } });

    await user.click(
      screen.getByRole('button', { name: 'Priority: No priority' })
    );
    await user.keyboard('2');

    expect(updateIssue).toHaveBeenCalledWith('2', { priority: 'high' });
    expect(
      await screen.findByRole('button', { name: 'Priority: High' })
    ).toBeInTheDocument();
  });

  it('writes the assignee picked on the row', async () => {
    const row = child('2', 'A child');
    echoWrites([row]);
    const user = userEvent.setup();
    renderSection({
      rows: [row],
      people,
      progress: { total: 1, completed: 0 },
    });

    await user.click(
      screen.getByRole('button', { name: 'Assignee: No assignee' })
    );
    await user.click(
      within(screen.getByRole('dialog', { name: 'Assignee' })).getByText(
        'Olive Owner'
      )
    );

    expect(updateIssue).toHaveBeenCalledWith('2', { assignee_id: 'u-1' });
  });
});

describe('reordering sub-issues', () => {
  it('writes the manual order a drop lands on and shows it at once', async () => {
    const rows = [child('2', 'First'), child('3', 'Second')];
    echoWrites(rows);
    renderSection({ rows, progress: { total: 2, completed: 0 } });
    expect(shownTitles()).toEqual(['ENG-2First', 'ENG-3Second']);

    const list = screen.getByRole('list', { name: 'Sub-issues' });
    const first = screen.getByText('First').closest('li') as HTMLElement;
    fireEvent.dragStart(first, dragData());
    fireEvent.dragOver(list, { ...dragData(), clientY: 1000 });
    fireEvent.drop(list, { ...dragData(), clientY: 1000 });

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledTimes(2);
    });
    const keys = new Map(
      updateIssue.mock.calls.map(([id, body]) => [
        id,
        (body as { sort_order: string }).sort_order,
      ])
    );
    expect((keys.get('3') ?? '') < (keys.get('2') ?? '')).toBe(true);
    expect(shownTitles()).toEqual(['ENG-3Second', 'ENG-2First']);
  });

  it('moves the focused row down a step on Alt+Down', async () => {
    const rows: OrderedIssueRead[] = [
      { ...child('2', 'First'), sort_order: 'a' },
      { ...child('3', 'Second'), sort_order: 'b' },
    ];
    echoWrites(rows);
    const user = userEvent.setup();
    renderSection({ rows, progress: { total: 2, completed: 0 } });

    screen.getByText('First').closest('a')?.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(updateIssue).toHaveBeenCalledTimes(1);
    const [id, body] = updateIssue.mock.calls[0] ?? [];
    expect(id).toBe('2');
    expect((body as { sort_order: string }).sort_order > 'b').toBe(true);
    expect(shownTitles()).toEqual(['ENG-3Second', 'ENG-2First']);
  });

  it('asks for manual ordering before a keyboard move', async () => {
    globalThis.localStorage.setItem(
      SUB_ISSUE_DISPLAY_KEY,
      JSON.stringify({ ordering: 'priority_desc', showCompleted: true })
    );
    const rows = [child('2', 'First'), child('3', 'Second')];
    const user = userEvent.setup();
    renderSection({ rows, progress: { total: 2, completed: 0 } });

    screen.getByText('First').closest('a')?.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(updateIssue).not.toHaveBeenCalled();
  });
});

describe('the sub-issue keyboard', () => {
  it('moves focus with j and k and opens the focused row picker with p', async () => {
    const rows = [child('2', 'First'), child('3', 'Second')];
    const user = userEvent.setup();
    renderSection({ rows, progress: { total: 2, completed: 0 } });

    const first = screen.getByText('First').closest('a') as HTMLElement;
    const second = screen.getByText('Second').closest('a') as HTMLElement;
    first.focus();
    await user.keyboard('j');
    expect(second).toHaveFocus();
    await user.keyboard('k');
    expect(first).toHaveFocus();

    await user.keyboard('p');
    const row = first.closest('li') as HTMLElement;
    expect(
      await within(row).findByRole('dialog', { name: 'Priority' })
    ).toBeInTheDocument();
  });
});

describe('hiding completed sub-issues', () => {
  it('folds them into a count that expands, and remembers the choice', async () => {
    const rows = [child('2', 'Open one'), child('3', 'Done one', 'st-4')];
    const user = userEvent.setup();
    const { unmount } = renderSection({
      rows,
      progress: { total: 2, completed: 1 },
    });

    await user.click(
      screen.getByRole('button', { name: 'Sub-issue display options' })
    );
    await user.click(screen.getByRole('switch', { name: 'Show completed' }));

    expect(screen.queryByText('Done one')).not.toBeInTheDocument();
    expect(screen.getByText('Open one')).toBeInTheDocument();
    expect(
      JSON.parse(globalThis.localStorage.getItem(SUB_ISSUE_DISPLAY_KEY) ?? '{}')
    ).toMatchObject({ showCompleted: false });

    unmount();
    renderSection({ rows, progress: { total: 2, completed: 1 } });
    expect(screen.queryByText('Done one')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '1 completed' }));
    expect(screen.getByText('Done one')).toBeInTheDocument();
  });
});

describe('the phone layout', () => {
  it('keeps a row to its status, title and set properties', () => {
    const set = {
      ...child('2', 'Has both'),
      priority: 'high' as const,
      assignee_id: 'u-1',
    };
    renderSection({
      rows: [set, child('3', 'Has neither')],
      progress: { total: 2, completed: 0 },
      people,
    });

    expect(screen.getByText('ENG-2')).toHaveClass('max-sm:hidden');
    expect(screen.getByText('Has both')).toHaveClass('truncate');
    const [full, bare] = screen.getAllByRole('listitem');
    expect(
      within(full as HTMLElement).getByRole('button', {
        name: 'Priority: High',
      })
    ).not.toHaveClass('max-sm:hidden');
    expect(
      within(full as HTMLElement).getByRole('button', {
        name: /^Assignee: /,
      })
    ).not.toHaveClass('max-sm:hidden');
    expect(
      within(bare as HTMLElement).getByRole('button', {
        name: 'Priority: No priority',
      })
    ).toHaveClass('max-sm:hidden');
    expect(
      within(bare as HTMLElement).getByRole('button', {
        name: 'Assignee: No assignee',
      })
    ).toHaveClass('max-sm:hidden');
  });

  it('draws a progress ring beside the count', () => {
    renderSection({
      rows: [child('2', 'A child', 'st-4'), child('3', 'Another')],
      progress: { total: 2, completed: 1 },
    });

    const count = screen.getByText('1/2');
    expect(count.querySelector('svg')).not.toBeNull();
  });
});
