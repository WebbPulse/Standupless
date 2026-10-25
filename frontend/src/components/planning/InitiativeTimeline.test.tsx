/**
 * The initiatives timeline. Covers that dated initiatives draw a bar with
 * their linked projects nested below and fold away with the chevron, that an
 * undated branch sits in the No dates section, that the today line is drawn,
 * that moving a bar from the keyboard writes only its dates and offers an undo
 * that writes the old ones back, and that clicking an empty lane schedules it.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InitiativeRead, ProjectRead } from '../../types/Api';
import InitiativeTimeline from './InitiativeTimeline';

const pushUndo =
  vi.fn<
    (workspaceId: string, message: string, revert: () => Promise<void>) => void
  >();

vi.mock('../../lib/undo', () => ({
  pushUndo: (
    workspaceId: string,
    message: string,
    revert: () => Promise<void>
  ) => {
    pushUndo(workspaceId, message, revert);
  },
}));

/** Builds an initiative with an empty rollup. */
const initiative = (
  id: string,
  name: string,
  overrides: Partial<InitiativeRead> = {}
): InitiativeRead =>
  ({
    initiative_id: id,
    workspace_id: 'ws-1',
    name,
    parent_initiative_id: null,
    ancestors: [],
    status: 'active',
    start_date: null,
    start_date_resolution: null,
    target_date: null,
    target_date_resolution: null,
    project_ids: [],
    counts: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
    points: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
    ...overrides,
  }) as InitiativeRead;

/** Builds a project with the given dates. */
const project = (
  id: string,
  name: string,
  overrides: Partial<ProjectRead> = {}
): ProjectRead =>
  ({
    project_id: id,
    name,
    key: id.toUpperCase(),
    slug: id,
    start_date: null,
    target_date: null,
    counts: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
    points: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
    ...overrides,
  }) as ProjectRead;

const launch = initiative('i-1', 'Launch', {
  start_date: '2026-11-02',
  target_date: '2026-11-20',
  project_ids: ['p-1'],
});
const someday = initiative('i-2', 'Someday');
const billing = project('p-1', 'Billing', { target_date: '2026-11-15' });

const move = vi.fn<(row: InitiativeRead, change: object) => Promise<boolean>>();
const put = vi.fn<(row: InitiativeRead, change: object) => Promise<void>>();

/** Draws the timeline over the given initiatives. */
const draw = (initiatives: InitiativeRead[], editable = true) =>
  render(
    <MemoryRouter>
      <InitiativeTimeline
        initiatives={initiatives}
        projects={[billing]}
        slug="acme"
        workspaceId="ws-1"
        zoom="month"
        editable={editable}
        move={move}
        put={put}
        testId="initiatives-timeline"
      />
    </MemoryRouter>
  );

describe('InitiativeTimeline', () => {
  beforeEach(() => {
    move.mockReset().mockResolvedValue(true);
    put.mockReset().mockResolvedValue(undefined);
    pushUndo.mockReset();
  });

  it('draws dated bars with their projects and a No dates section', async () => {
    draw([launch, someday]);
    const dated = screen.getByRole('list', {
      name: 'Initiatives on the timeline',
    });
    expect(
      within(dated).getByRole('slider', { name: /^Launch, / })
    ).toBeInTheDocument();
    expect(
      within(dated).getByRole('link', { name: /^Billing, / })
    ).toBeInTheDocument();
    const undated = screen.getByRole('region', { name: 'No dates' });
    expect(within(undated).getByText('Someday')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-today')).toBeInTheDocument();
    expect(screen.getByText('2 initiatives')).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'Collapse Launch' })
    );
    expect(
      within(dated).queryByRole('link', { name: /^Billing, / })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Expand Launch' })
    ).toBeInTheDocument();
  });

  it('moves a bar from the keyboard and undoes it with the old dates', async () => {
    draw([launch]);
    const bar = screen.getByRole('slider', { name: /^Launch, / });
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    expect(move).toHaveBeenCalledWith(launch, {
      start_date: '2026-11-03',
      target_date: '2026-11-21',
    });
    await vi.waitFor(() => {
      expect(pushUndo).toHaveBeenCalledTimes(1);
    });
    const [workspaceId, message, revert] = pushUndo.mock.calls[0] ?? [];
    expect(workspaceId).toBe('ws-1');
    expect(message).toBe('Moved Launch');
    await revert?.();
    expect(put).toHaveBeenCalledWith(launch, {
      start_date: '2026-11-02',
      start_date_resolution: null,
      target_date: '2026-11-20',
      target_date_resolution: null,
    });
  });

  it('changes only the target with Shift and offers no undo on a failed write', async () => {
    move.mockResolvedValue(false);
    draw([launch]);
    fireEvent.keyDown(screen.getByRole('slider', { name: /^Launch, / }), {
      key: 'ArrowLeft',
      shiftKey: true,
    });
    expect(move).toHaveBeenCalledWith(launch, { target_date: '2026-11-19' });
    await Promise.resolve();
    await Promise.resolve();
    expect(pushUndo).not.toHaveBeenCalled();
  });

  it('schedules an undated initiative from a click on its lane', () => {
    draw([someday]);
    fireEvent.click(screen.getByTestId('initiative-lane-i-2'));
    expect(move).toHaveBeenCalledTimes(1);
    const change = move.mock.calls[0]?.[1] as {
      start_date: string;
      target_date: string;
    };
    const days =
      (Date.parse(change.target_date) - Date.parse(change.start_date)) /
      86_400_000;
    expect(days).toBe(27);
  });

  it('does not move or schedule when the viewer cannot edit', () => {
    draw([launch, someday], false);
    fireEvent.keyDown(screen.getByRole('slider', { name: /^Launch, / }), {
      key: 'ArrowRight',
    });
    fireEvent.click(screen.getByTestId('initiative-lane-i-2'));
    expect(move).not.toHaveBeenCalled();
  });
});
