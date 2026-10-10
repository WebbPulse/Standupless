/**
 * The Filter button: that F opens its field list from anywhere in the view,
 * as Linear's does, and that the key stands down while the list is open. The
 * chips: that team and date clauses read and flip like the others.
 */

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
} from '../../../hooks/useShortcuts';
import type { IssueContext } from '../../../lib/issueView';
import { FilterButton, FilterChips } from './FilterBar';

const context: IssueContext = {
  statuses: [],
  labels: [],
  people: [],
  projects: [],
  cycles: [],
};

describe('FilterButton', () => {
  it('opens the field list on F', () => {
    const registry = createShortcutRegistry();
    render(
      <ShortcutRegistryContext.Provider value={registry}>
        <FilterButton filters={[]} context={context} onChange={vi.fn()} />
      </ShortcutRegistryContext.Provider>
    );
    expect(screen.queryAllByLabelText('Filter by')).toHaveLength(0);

    act(() => {
      registry.handleKey(new KeyboardEvent('keydown', { key: 'f' }));
    });

    expect(screen.getAllByLabelText('Filter by').length).toBeGreaterThan(0);
    expect(registry.list().some((shortcut) => shortcut.keys === 'f')).toBe(
      false
    );
  });
});

describe('FilterChips', () => {
  const teams: IssueContext = {
    ...context,
    teams: [
      { id: 'team-1', name: 'Engine', key: 'ENG' },
      { id: 'team-2', name: 'Design', key: 'DES' },
    ],
  };

  it('names the teams a team clause holds and flips it to an exclusion', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FilterChips
        filters={[{ field: 'team', op: 'is', values: ['team-1'] }]}
        context={teams}
        onChange={onChange}
      />
    );

    expect(screen.getByText('Engine')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Team is, switch' }));

    expect(onChange).toHaveBeenCalledWith([
      { field: 'team', op: 'is_not', values: ['team-1'] },
    ]);
  });

  it('reads a date clause as a bound and flips before to after', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FilterChips
        filters={[{ field: 'created', op: 'before', values: ['2026-10-01'] }]}
        context={context}
        onChange={onChange}
      />
    );

    const flip = screen.getByRole('button', { name: 'Created before, switch' });
    expect(flip).toHaveTextContent('before');
    await user.click(flip);

    expect(onChange).toHaveBeenCalledWith([
      { field: 'created', op: 'after', values: ['2026-10-01'] },
    ]);
  });

  it('will not flip a date clause onto a bound already set', () => {
    render(
      <FilterChips
        filters={[
          { field: 'due', op: 'after', values: ['2026-10-01'] },
          { field: 'due', op: 'before', values: ['2026-10-31'] },
        ]}
        context={context}
        onChange={vi.fn()}
      />
    );

    expect(
      screen.getByRole('button', { name: 'Due date after, switch' })
    ).toBeDisabled();
  });
});
