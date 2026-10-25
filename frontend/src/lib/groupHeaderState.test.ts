/**
 * The group header choice travels like every other display option: through
 * the URL, a saved view and a team default, reading as the count when absent.
 */

import { describe, expect, it } from 'vitest';
import type { SavedViewDisplayRead } from '../api/views';
import {
  defaultViewState,
  parseViewState,
  sameViewState,
  stateToViewBody,
  viewToState,
  writeViewState,
  type ViewState,
} from './issueView';
import { stateToTeamDisplay, teamDefaultState } from './teamDisplay';

const base = defaultViewState('list');
const estimate: ViewState = { ...base, groupHeader: 'estimate' };

describe('the group header option', () => {
  it('defaults to the issue count', () => {
    expect(base.groupHeader).toBe('count');
  });

  it('round trips through the URL', () => {
    const params = writeViewState(estimate, base);
    expect(params.get('head')).toBe('estimate');
    expect(parseViewState(params, base).groupHeader).toBe('estimate');
    expect(writeViewState(base, base).has('head')).toBe(false);
    expect(
      parseViewState(new URLSearchParams('head=points'), base).groupHeader
    ).toBe('count');
    expect(sameViewState(estimate, base)).toBe(false);
  });

  it('saves with a view and reads back', () => {
    const body = stateToViewBody(estimate, 'Sized work');
    expect(body).toMatchObject({ group_header: 'estimate' });
    const view = {
      view_id: 'v-1',
      ...body,
      team_id: null,
    } as unknown as SavedViewDisplayRead;
    expect(viewToState(view).groupHeader).toBe('estimate');
    const { group_header: _dropped, ...older } = view;
    expect(viewToState(older).groupHeader).toBe('count');
  });

  it('is kept as a team default', () => {
    expect(stateToTeamDisplay(estimate).group_header).toBe('estimate');
    expect(
      teamDefaultState('list', { group_header: 'estimate' }).groupHeader
    ).toBe('estimate');
    expect(teamDefaultState('list', {}).groupHeader).toBe('count');
  });
});
