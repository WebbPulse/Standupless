/**
 * The transition rules section. The distinction worth pinning is inherited
 * against set: a default row is not stored, so choosing a status against one
 * must create a rule rather than patch an id the backend does not hold, and
 * only a stored rule may be cleared back to the default.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatusRead, TransitionRead } from '../../types/Api';
import TransitionsSection from './TransitionsSection';

const listTransitions = vi.fn<() => Promise<TransitionRead[]>>();
const createTransition = vi.fn<(body: unknown) => Promise<TransitionRead>>();
const updateTransition =
  vi.fn<(id: string, body: unknown) => Promise<TransitionRead>>();
const deleteTransition = vi.fn<(id: string) => Promise<void>>();
const listStatuses = vi.fn<() => Promise<StatusRead[]>>();

vi.mock('../../api/integrations', async () => {
  const actual = await vi.importActual<typeof import('../../api/integrations')>(
    '../../api/integrations'
  );
  return {
    ...actual,
    listTransitions: () => listTransitions(),
    createTransition: (_w: string, _p: string, body: unknown) =>
      createTransition(body),
    updateTransition: (_w: string, _p: string, id: string, body: unknown) =>
      updateTransition(id, body),
    deleteTransition: (_w: string, _p: string, id: string) =>
      deleteTransition(id),
  };
});

vi.mock('../../api/teams', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/teams')>('../../api/teams');
  return { ...actual, listStatuses: () => listStatuses() };
});

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

/** The statuses a rule may land an issue on. */
const statuses: StatusRead[] = [
  { id: 'st-1', name: 'Todo', category: 'unstarted', position: 0 },
  { id: 'st-2', name: 'In Progress', category: 'started', position: 1 },
  { id: 'st-3', name: 'Done', category: 'completed', position: 2 },
];

/** One rule in the shape the contract answers with. */
const rule = (over: Partial<TransitionRead> = {}): TransitionRead => ({
  transition_id: 'tr-1',
  team_id: 'proj-1',
  trigger: 'pr_merged',
  status_id: 'st-3',
  is_default: false,
  ...over,
});

const renderSection = (canEdit = true) =>
  render(
    <TransitionsSection workspaceId="ws-1" teamId="proj-1" canEdit={canEdit} />
  );

beforeEach(() => {
  listTransitions.mockReset();
  createTransition.mockReset();
  updateTransition.mockReset();
  deleteTransition.mockReset();
  listStatuses.mockReset();
  listTransitions.mockResolvedValue([rule()]);
  createTransition.mockResolvedValue(rule({ transition_id: 'tr-2' }));
  updateTransition.mockResolvedValue(rule({ status_id: 'st-2' }));
  deleteTransition.mockResolvedValue(undefined);
  listStatuses.mockResolvedValue(statuses);
});

describe('the transitions section', () => {
  it('shows a row for every trigger', async () => {
    renderSection();

    expect(await screen.findByText('A pull request opens')).toBeInTheDocument();
    expect(screen.getByText('A pull request merges')).toBeInTheDocument();
    expect(
      screen.getByText('A pull request is marked ready for review')
    ).toBeInTheDocument();
    expect(
      screen.getByText('A pull request closes without merging')
    ).toBeInTheDocument();
  });

  it('marks a stored rule as set and an absent one as inherited', async () => {
    renderSection();

    expect(await screen.findByText('Set for this team')).toBeInTheDocument();
    expect(screen.getAllByText('Inherited default')).toHaveLength(3);
  });

  it('creates a rule when a trigger has none stored', async () => {
    renderSection();

    const select = await screen.findByLabelText('A pull request opens');
    await userEvent.selectOptions(select, 'st-2');

    await waitFor(() => {
      expect(createTransition).toHaveBeenCalledWith({
        trigger: 'pr_opened',
        status_id: 'st-2',
      });
    });
    expect(updateTransition).not.toHaveBeenCalled();
  });

  it('patches a rule the team already stores', async () => {
    renderSection();

    const select = await screen.findByLabelText('A pull request merges');
    await userEvent.selectOptions(select, 'st-2');

    await waitFor(() => {
      expect(updateTransition).toHaveBeenCalledWith('tr-1', {
        status_id: 'st-2',
      });
    });
    expect(createTransition).not.toHaveBeenCalled();
  });

  it('offers going back to the default only for a stored rule', async () => {
    renderSection();

    await waitFor(() => {
      expect(
        screen.getAllByRole('button', { name: 'Use default' })
      ).toHaveLength(1);
    });

    await userEvent.click(screen.getByRole('button', { name: 'Use default' }));

    await waitFor(() => {
      expect(deleteTransition).toHaveBeenCalledWith('tr-1');
    });
  });

  it('shows a reader the rules without letting them change one', async () => {
    renderSection(false);

    expect(
      await screen.findByLabelText('A pull request merges')
    ).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Use default' })
    ).not.toBeInTheDocument();
  });
});
