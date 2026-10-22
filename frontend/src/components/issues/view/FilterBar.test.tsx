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

describe('filter logic', () => {
  const labelled: IssueContext = {
    ...context,
    labels: [
      { id: 'lb-bug', name: 'Bug', color: '#ef4444', team_id: 'team-1' },
      { id: 'lb-ui', name: 'UI', color: '#3b82f6', team_id: 'team-1' },
    ],
  };

  it('adds an any group from the field list', async () => {
    const user = userEvent.setup();
    const registry = createShortcutRegistry();
    const onLogicChange = vi.fn();
    const filters = [
      { field: 'priority' as const, op: 'is' as const, values: ['high'] },
    ];
    render(
      <ShortcutRegistryContext.Provider value={registry}>
        <FilterButton
          filters={filters}
          context={context}
          onChange={vi.fn()}
          onLogicChange={onLogicChange}
        />
      </ShortcutRegistryContext.Provider>
    );

    act(() => {
      registry.handleKey(new KeyboardEvent('keydown', { key: 'f' }));
    });
    await user.click(screen.getByText('Add filter group'));

    expect(onLogicChange).toHaveBeenCalledWith({
      filters,
      match: 'all',
      groups: [{ match: 'any', filters: [] }],
    });
  });

  it('offers no group without a logic handler', () => {
    const registry = createShortcutRegistry();
    render(
      <ShortcutRegistryContext.Provider value={registry}>
        <FilterButton filters={[]} context={context} onChange={vi.fn()} />
      </ShortcutRegistryContext.Provider>
    );

    act(() => {
      registry.handleKey(new KeyboardEvent('keydown', { key: 'f' }));
    });

    expect(screen.queryByText('Add filter group')).not.toBeInTheDocument();
  });

  it('switches the top level match and edits a group on its own', async () => {
    const user = userEvent.setup();
    const onLogicChange = vi.fn();
    const filters = [
      { field: 'priority' as const, op: 'is' as const, values: ['high'] },
    ];
    const groups = [
      {
        match: 'any' as const,
        filters: [
          { field: 'label' as const, op: 'is' as const, values: ['lb-bug'] },
        ],
      },
    ];
    render(
      <FilterChips
        filters={filters}
        groups={groups}
        context={labelled}
        onChange={vi.fn()}
        onLogicChange={onLogicChange}
      />
    );

    await user.click(
      screen.getByRole('button', { name: 'Filters match all, switch' })
    );
    expect(onLogicChange).toHaveBeenLastCalledWith({
      filters,
      match: 'any',
      groups,
    });

    expect(
      screen.getByRole('group', { name: 'Filter group 1' })
    ).toHaveTextContent('Match any');
    await user.click(
      screen.getByRole('button', { name: 'Filter group 1 match any, switch' })
    );
    expect(onLogicChange).toHaveBeenLastCalledWith({
      filters,
      match: 'all',
      groups: [{ ...groups[0], match: 'all' }],
    });

    await user.click(
      screen.getByRole('button', { name: 'Remove filter group 1' })
    );
    expect(onLogicChange).toHaveBeenLastCalledWith({
      filters,
      match: 'all',
      groups: [],
    });

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onLogicChange).toHaveBeenLastCalledWith({
      filters: [],
      match: 'all',
      groups: [],
    });
  });

  it('reads a content clause as contains and flips it to does not contain', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FilterChips
        filters={[{ field: 'content', op: 'is', values: ['token'] }]}
        context={context}
        onChange={onChange}
      />
    );

    expect(screen.getByText(/token/)).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Content contains, switch' })
    );

    expect(onChange).toHaveBeenCalledWith([
      { field: 'content', op: 'is_not', values: ['token'] },
    ]);
  });

  it('flips a label clause holding two labels to includes all of', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FilterChips
        filters={[{ field: 'label', op: 'is', values: ['lb-bug', 'lb-ui'] }]}
        context={labelled}
        onChange={onChange}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Labels is, switch' }));

    expect(onChange).toHaveBeenCalledWith([
      { field: 'label', op: 'all', values: ['lb-bug', 'lb-ui'] },
    ]);
  });
});
