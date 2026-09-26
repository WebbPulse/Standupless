/**
 * The Filter button: that F opens its field list from anywhere in the view,
 * as Linear's does, and that the key stands down while the list is open.
 */

import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
} from '../../../hooks/useShortcuts';
import type { IssueContext } from '../../../lib/issueView';
import { FilterButton } from './FilterBar';

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
