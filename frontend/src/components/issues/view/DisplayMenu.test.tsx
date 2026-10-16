/**
 * The display menu's grouping choices and ordering direction: the planning
 * groupings are offered, team only where the list spans teams, and the
 * direction button flips the ordering except under manual ordering.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  defaultViewState,
  fieldsFor,
  GROUP_FIELDS,
  type ViewState,
} from '../../../lib/issueView';
import DisplayMenu from './DisplayMenu';

const optionsOf = (select: HTMLElement): string[] =>
  within(select)
    .getAllByRole('option')
    .map((option) => option.textContent ?? '');

describe('DisplayMenu', () => {
  it('offers the planning groupings, and team over several teams', async () => {
    const user = userEvent.setup();
    render(
      <DisplayMenu
        state={defaultViewState('list')}
        onChange={vi.fn<(state: ViewState) => void>()}
        groupFields={fieldsFor(GROUP_FIELDS, {
          teams: [
            { id: 'team-1', name: 'Engineering' },
            { id: 'team-2', name: 'Design' },
          ],
        })}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Display' }));

    expect(optionsOf(screen.getByLabelText('Grouping'))).toEqual(
      expect.arrayContaining([
        'Project',
        'Cycle',
        'Parent issue',
        'Team',
        'SLA status',
      ])
    );
    expect(optionsOf(screen.getByLabelText('Ordering'))).toEqual(
      expect.arrayContaining(['Status', 'Start date', 'Estimate'])
    );
  });

  it('leaves team out of a single team list', async () => {
    const user = userEvent.setup();
    render(
      <DisplayMenu
        state={defaultViewState('list')}
        onChange={vi.fn<(state: ViewState) => void>()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Display' }));

    const grouping = optionsOf(screen.getByLabelText('Grouping'));
    expect(grouping).toContain('Project');
    expect(grouping).not.toContain('Team');
  });

  it('reverses the ordering and resets it for manual ordering', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(state: ViewState) => void>();
    const state: ViewState = { ...defaultViewState('list'), reverse: true };
    const { rerender } = render(
      <DisplayMenu state={defaultViewState('list')} onChange={onChange} />
    );

    await user.click(screen.getByRole('button', { name: 'Display' }));
    const flip = screen.getByRole('button', { name: 'Reverse ordering' });
    expect(flip).toHaveAttribute('aria-pressed', 'false');
    await user.click(flip);

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ reverse: true })
    );

    rerender(<DisplayMenu state={state} onChange={onChange} />);
    await user.selectOptions(screen.getByLabelText('Ordering'), 'manual');

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ ordering: 'manual', reverse: false })
    );

    rerender(
      <DisplayMenu
        state={{ ...state, ordering: 'manual', reverse: false }}
        onChange={onChange}
      />
    );
    expect(
      screen.getByRole('button', { name: 'Reverse ordering' })
    ).toBeDisabled();
  });
});
