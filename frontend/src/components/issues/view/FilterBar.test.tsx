/**
 * The Filter button: that F opens its field list from anywhere in the view,
 * as Linear's does, and that the key stands down while the list is open. The
 * chips: that team and date clauses read and flip like the others, that a
 * relative date reads as a rolling window and a preset stores its offset. The
 * removal keys: that Shift F drops the newest filter and Alt Shift F clears
 * them all, as Linear's do, and that neither binds with nothing to remove.
 * My teams: that the chip names it and the hint names the platform modifier.
 */

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
} from '../../../hooks/useShortcuts';
import type { IssueContext } from '../../../lib/issueView';
import { MY_TEAMS } from '../../../lib/issueView';
import {
  FilterButton,
  FilterChips,
  selectOnlyHint,
  withoutLastFilter,
} from './FilterBar';

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

  it('reads a My teams clause as My teams', () => {
    render(
      <FilterChips
        filters={[{ field: 'team', op: 'is', values: [MY_TEAMS] }]}
        context={teams}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText('My teams')).toBeInTheDocument();
  });

  it('names Option on Apple platforms and Alt elsewhere', () => {
    expect(selectOnlyHint(true)).toBe('Option+click to select only one');
    expect(selectOnlyHint(false)).toBe('Alt+click to select only one');
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

  it('reads a relative date clause as a rolling window', () => {
    render(
      <FilterChips
        filters={[
          { field: 'created', op: 'after', values: ['-2w'] },
          { field: 'due', op: 'before', values: ['+1w'] },
        ]}
        context={context}
        onChange={vi.fn()}
      />
    );

    expect(
      screen.getByRole('button', { name: 'Created after, switch' })
    ).toHaveTextContent('in the last');
    expect(screen.getByRole('button', { name: '2 weeks' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Due date before, switch' })
    ).toHaveTextContent('within');
    expect(screen.getByRole('button', { name: '1 week' })).toBeInTheDocument();
  });

  it('stores a date preset as its relative offset', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FilterChips
        filters={[{ field: 'created', op: 'after', values: ['2026-10-01'] }]}
        context={context}
        onChange={onChange}
      />
    );

    await user.click(screen.getByRole('button', { name: /2026/ }));
    await user.click(screen.getByRole('option', { name: /^1 month ago/ }));

    expect(onChange).toHaveBeenCalledWith([
      { field: 'created', op: 'after', values: ['-1m'] },
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

describe('filter removal keys', () => {
  const priority = {
    field: 'priority' as const,
    op: 'is' as const,
    values: ['high'],
  };
  const label = {
    field: 'label' as const,
    op: 'is' as const,
    values: ['lb-bug'],
  };
  const group = { match: 'any' as const, filters: [label] };

  /** Presses one key on the registry. */
  const press = (
    registry: ReturnType<typeof createShortcutRegistry>,
    init: KeyboardEventInit
  ): void => {
    act(() => {
      registry.handleKey(new KeyboardEvent('keydown', init));
    });
  };

  it('drops the newest filter on Shift F', () => {
    const registry = createShortcutRegistry();
    const onChange = vi.fn();
    render(
      <ShortcutRegistryContext.Provider value={registry}>
        <FilterButton
          filters={[priority, label]}
          context={context}
          onChange={onChange}
        />
      </ShortcutRegistryContext.Provider>
    );

    press(registry, { key: 'F', shiftKey: true, code: 'KeyF' });

    expect(onChange).toHaveBeenCalledWith([priority]);
    expect(screen.queryAllByLabelText('Filter by')).toHaveLength(0);
  });

  it('clears every filter and group on Alt Shift F', () => {
    const registry = createShortcutRegistry();
    const onLogicChange = vi.fn();
    render(
      <ShortcutRegistryContext.Provider value={registry}>
        <FilterButton
          filters={[priority]}
          match="any"
          groups={[group]}
          context={context}
          onChange={vi.fn()}
          onLogicChange={onLogicChange}
        />
      </ShortcutRegistryContext.Provider>
    );

    press(registry, {
      key: 'Ï',
      shiftKey: true,
      altKey: true,
      code: 'KeyF',
    });

    expect(onLogicChange).toHaveBeenCalledWith({
      filters: [],
      match: 'all',
      groups: [],
    });
  });

  it('clears flat filters on Alt Shift F without a logic handler', () => {
    const registry = createShortcutRegistry();
    const onChange = vi.fn();
    render(
      <ShortcutRegistryContext.Provider value={registry}>
        <FilterButton
          filters={[priority, label]}
          context={context}
          onChange={onChange}
        />
      </ShortcutRegistryContext.Provider>
    );

    press(registry, {
      key: 'F',
      shiftKey: true,
      altKey: true,
      code: 'KeyF',
    });

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('binds neither key with nothing to remove', () => {
    const registry = createShortcutRegistry();
    render(
      <ShortcutRegistryContext.Provider value={registry}>
        <FilterButton filters={[]} context={context} onChange={vi.fn()} />
      </ShortcutRegistryContext.Provider>
    );

    const keys = registry.list().map((shortcut) => shortcut.keys);
    expect(keys).not.toContain('shift+f');
    expect(keys).not.toContain('alt+shift+f');
  });

  it('lists all three keys under Filters', () => {
    const registry = createShortcutRegistry();
    render(
      <ShortcutRegistryContext.Provider value={registry}>
        <FilterButton
          filters={[priority]}
          context={context}
          onChange={vi.fn()}
        />
      </ShortcutRegistryContext.Provider>
    );

    const filters = registry
      .list()
      .filter((shortcut) => shortcut.group === 'Filters')
      .map((shortcut) => shortcut.label);
    expect(filters).toEqual([
      'Add filter',
      'Remove last filter',
      'Clear all filters',
    ]);
  });

  it('drops the last group once the flat filters are gone', () => {
    expect(
      withoutLastFilter({ filters: [], match: 'any', groups: [group, group] })
    ).toEqual({ filters: [], match: 'any', groups: [group] });
    expect(
      withoutLastFilter({ filters: [priority], match: 'all', groups: [group] })
    ).toEqual({ filters: [], match: 'all', groups: [group] });
  });
});

describe('customer field chips', () => {
  const customers: IssueContext = {
    ...context,
    customers: [],
    customerStatuses: [{ id: 'active', name: 'Active', color: '#4cb782' }],
    customerTiers: [{ id: 'tier-growth', name: 'Growth', color: null }],
  };

  it('name the status and tier and format the revenue', () => {
    render(
      <FilterChips
        filters={[
          { field: 'customer_status', op: 'is', values: ['active'] },
          { field: 'customer_tier', op: 'is_not', values: ['tier-growth'] },
          { field: 'customer_revenue', op: 'at_least', values: ['1200000'] },
          { field: 'customer_requests', op: 'at_most', values: ['0'] },
        ]}
        context={customers}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Growth')).toBeInTheDocument();
    expect(screen.getByText('$1.2M')).toBeInTheDocument();
    expect(screen.getByText('at least')).toBeInTheDocument();
    expect(screen.getByText('at most')).toBeInTheDocument();
  });

  it('flips a number bound between at least and at most', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FilterChips
        filters={[{ field: 'customer_size', op: 'at_least', values: ['50'] }]}
        context={customers}
        onChange={onChange}
      />
    );

    await user.click(
      screen.getByRole('button', { name: 'Customer size at least, switch' })
    );

    expect(onChange).toHaveBeenCalledWith([
      { field: 'customer_size', op: 'at_most', values: ['50'] },
    ]);
  });
});
