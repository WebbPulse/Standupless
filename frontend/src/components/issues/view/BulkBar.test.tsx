/**
 * The bulk bar's More menu: it lists the caller's entries in their groups,
 * runs the one picked, and stays out of the bar when there is nothing to put
 * in it. The toolbar takes the caller's name so another kind of selection
 * can use the same bar.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import BulkBar, { type BulkBarMenuItem } from './BulkBar';

/** A menu entry that records being picked. */
const item = (id: string, label: string): BulkBarMenuItem => ({
  id,
  label,
  icon: null,
  onSelect: vi.fn(),
});

const renderBar = (
  more: readonly (readonly BulkBarMenuItem[])[],
  label?: string
) =>
  render(
    <BulkBar
      count={2}
      estimates
      onProperty={vi.fn()}
      onClear={vi.fn()}
      more={more}
      {...(label === undefined ? {} : { label })}
    />
  );

describe('BulkBar', () => {
  it('runs the More menu entry picked', async () => {
    const user = userEvent.setup();
    const subscribe = item('subscribe', 'Subscribe');
    const copy = item('copy', 'Copy IDs');
    renderBar([[subscribe], [copy]]);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: /Copy IDs/ })).toBeVisible();
    await user.click(screen.getByRole('menuitem', { name: /Subscribe/ }));

    expect(subscribe.onSelect).toHaveBeenCalledTimes(1);
    expect(copy.onSelect).not.toHaveBeenCalled();
  });

  it('leaves the More menu out when it has no entries', () => {
    renderBar([[], []]);

    expect(
      screen.queryByRole('button', { name: 'More actions' })
    ).not.toBeInTheDocument();
  });

  it('names the toolbar after the selection', () => {
    renderBar([], 'Selected projects');

    expect(
      screen.getByRole('toolbar', { name: 'Selected projects' })
    ).toBeInTheDocument();
  });
});
