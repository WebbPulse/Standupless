/**
 * Folded groups, swimlanes and hidden board columns as part of a saved view's
 * state. Covers that they travel in the URL over the view's own folds, count
 * as a change until saved in any order, save with the view and read back.
 */

import { describe, expect, it } from 'vitest';
import type { SavedViewDisplayRead } from '../api/views';
import {
  defaultViewState,
  parseViewState,
  sameViewState,
  stateToViewBody,
  stateToViewDisplay,
  viewToState,
  writeViewState,
  type ViewState,
} from './issueView';

const base: ViewState = { ...defaultViewState('board'), collapsed: ['done'] };

describe('view folds', () => {
  it('opens on the view folds and writes nothing while they are unchanged', () => {
    expect(parseViewState(new URLSearchParams(), base).collapsed).toEqual([
      'done',
    ]);
    expect(writeViewState(base, base).has('fold')).toBe(false);
    expect(
      writeViewState({ ...base, collapsed: ['done'] }, base).toString()
    ).toBe('');
  });

  it('carries a change of folds in the URL and reads it back', () => {
    const folded: ViewState = {
      ...base,
      collapsed: ['done', 'lane/high', 'hidden:todo'],
    };
    const params = writeViewState(folded, base);

    expect(params.getAll('fold')).toEqual(['done', 'lane/high', 'hidden:todo']);
    expect(parseViewState(params, base).collapsed).toEqual([
      'done',
      'lane/high',
      'hidden:todo',
    ]);
  });

  it('marks every fold undone with an empty parameter', () => {
    const open: ViewState = { ...base, collapsed: [] };
    const params = writeViewState(open, base);

    expect(params.getAll('fold')).toEqual(['']);
    expect(parseViewState(params, base).collapsed).toEqual([]);
  });

  it('keeps the parameters it does not own and replaces its own', () => {
    const keep = new URLSearchParams('view=v1&fold=stale');
    const params = writeViewState(base, base, keep);

    expect(params.get('view')).toBe('v1');
    expect(params.has('fold')).toBe(false);
  });

  it('counts a fold as a change, whatever order the keys sit in', () => {
    expect(sameViewState({ ...base, collapsed: ['a', 'b'] }, base)).toBe(false);
    expect(
      sameViewState(
        { ...base, collapsed: ['a', 'b'] },
        { ...base, collapsed: ['b', 'a'] }
      )
    ).toBe(true);
  });

  it('saves the folds with the view and reads them back', () => {
    const state: ViewState = { ...base, collapsed: ['lane/high'] };

    expect(stateToViewDisplay(state).collapsed_groups).toEqual(['lane/high']);
    const body = stateToViewBody(state, 'Folded');
    expect(body.collapsed_groups).toEqual(['lane/high']);
    const view = {
      view_id: 'v-1',
      ...body,
      team_id: null,
    } as unknown as SavedViewDisplayRead;
    expect(viewToState(view).collapsed).toEqual(['lane/high']);
    expect(sameViewState(viewToState(view), state)).toBe(true);
  });

  it('reads a view saved before folds were kept as folding nothing', () => {
    const view = {
      view_id: 'v-2',
      name: 'Old',
      kind: 'list',
      filter: {},
      sort: 'updated_desc',
      group_by: 'status',
      layout: 'list',
    } as unknown as SavedViewDisplayRead;

    expect(viewToState(view).collapsed).toEqual([]);
  });
});
