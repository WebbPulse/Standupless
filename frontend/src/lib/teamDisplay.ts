/**
 * A team's default display, read into the state a team page opens with and
 * written back from what an admin has on screen. Only the display options
 * travel: filters stay with the person or the saved view, so a team default
 * changes how the team's issues look and never which issues show.
 */

import type { TeamDisplayOptions } from '../api/teams';
import type { ViewLayout } from '../api/views';
import { defaultViewState, type GroupField, type ViewState } from './issueView';

/**
 * The state a team page in `layout` opens with: the built-in default with
 * every option the team saved laid over it.
 */
export const teamDefaultState = (
  layout: ViewLayout,
  options: TeamDisplayOptions | null | undefined
): ViewState => {
  const shown = options?.layout ?? layout;
  const base = defaultViewState(shown);
  if (options === null || options === undefined) return base;
  const groupBy: GroupField = options.group_by ?? base.groupBy;
  const sub: GroupField = options.sub_group_by ?? base.subGroupBy;
  return {
    ...base,
    groupBy,
    subGroupBy: groupBy === 'none' || sub === groupBy ? 'none' : sub,
    ordering: options.ordering ?? base.ordering,
    reverse: options.ordering_reversed ?? base.reverse,
    visible: options.visible_properties ?? base.visible,
    showEmpty: options.show_empty_groups ?? base.showEmpty,
    showSubIssues: options.show_sub_issues ?? base.showSubIssues,
    completed: options.completed_window ?? base.completed,
    showArchived: options.show_archived ?? base.showArchived,
    groupHeader: options.group_header ?? base.groupHeader,
  };
};

/** The display options a state saves as a team default, every one set. */
export const stateToTeamDisplay = (state: ViewState): TeamDisplayOptions => ({
  layout: state.layout,
  group_by: state.groupBy,
  sub_group_by:
    state.groupBy === 'none' || state.subGroupBy === state.groupBy
      ? 'none'
      : state.subGroupBy,
  ordering: state.ordering,
  ordering_reversed: state.reverse,
  visible_properties: state.visible,
  show_sub_issues: state.showSubIssues,
  completed_window: state.completed,
  show_empty_groups: state.showEmpty,
  show_archived: state.showArchived,
  group_header: state.groupHeader,
});
