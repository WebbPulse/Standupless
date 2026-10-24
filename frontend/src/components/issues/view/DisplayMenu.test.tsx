/**
 * The display menu's grouping choices and ordering direction: the planning
 * groupings are offered, team only where the list spans teams, and the
 * direction button flips the ordering except under manual ordering. Also the
 * completed issues window, the milestone and links properties, and the team
 * default actions an admin sees in the footer.
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

  it('offers the customer orderings only where the list allows them', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DisplayMenu
        state={defaultViewState('list')}
        onChange={vi.fn<(state: ViewState) => void>()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Display' }));
    expect(optionsOf(screen.getByLabelText('Ordering'))).not.toContain(
      'Customer requests'
    );

    rerender(
      <DisplayMenu
        state={defaultViewState('list')}
        onChange={vi.fn<(state: ViewState) => void>()}
        customerSorts
      />
    );
    expect(optionsOf(screen.getByLabelText('Ordering'))).toEqual(
      expect.arrayContaining(['Customer requests', 'Customer revenue'])
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

  it('picks how far back completed issues show', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(state: ViewState) => void>();
    render(
      <DisplayMenu state={defaultViewState('list')} onChange={onChange} />
    );

    await user.click(screen.getByRole('button', { name: 'Display' }));
    const completed = screen.getByLabelText('Completed issues');
    expect(optionsOf(completed)).toEqual([
      'All',
      'Past week',
      'Past month',
      'None',
    ]);
    await user.selectOptions(completed, 'past_month');

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ completed: 'past_month' })
    );
    expect(
      screen.getByRole('button', { name: 'Milestone', pressed: false })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Links', pressed: false })
    ).toBeInTheDocument();
  });

  it('offers the team default actions an admin is given', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onClear = vi.fn();
    render(
      <DisplayMenu
        state={defaultViewState('list')}
        onChange={vi.fn<(state: ViewState) => void>()}
        teamDefault={{ onSave, onClear }}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Display' }));
    await user.click(
      screen.getByRole('button', { name: 'Save as team default' })
    );
    await user.click(
      screen.getByRole('button', { name: 'Clear team default' })
    );

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'Reset to default' })
    ).not.toBeInTheDocument();
  });
});
