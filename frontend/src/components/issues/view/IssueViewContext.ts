/**
 * What every row, card and header of one issue view reads: the resolved
 * lists, the display state, the write path and the selection. Held in a
 * context so a row nested two groups deep does not take a dozen props
 * threaded through each layer between it and the view.
 */

import { createContext, useContext } from 'react';
import type { OrderedIssueRead } from '../../../api/issues';
import type { IssueCollection } from '../../../hooks/useIssueCollection';
import type { IssueContext, ViewState } from '../../../lib/issueView';
import type { EstimateScale, LabelRead } from '../../../types/Api';

/** The shared state of one issue view. */
export interface IssueViewEnv {
  slug: string;
  state: ViewState;
  /** Every team's lists merged, for grouping and filtering. */
  context: IssueContext;
  /** One team's lists, for the pickers on that team's issues. */
  forTeam: (teamId: string) => IssueContext;
  /** The estimate scale of an issue's team. */
  scaleFor: (teamId: string) => EstimateScale;
  /** The team name shown on rows of a view that spans teams. */
  teamNameFor?: (teamId: string) => string | undefined;
  canEdit: boolean;
  update: IssueCollection['update'];
  createLabel: (teamId: string, name: string) => Promise<LabelRead | null>;
  /** The row the keyboard sits on, or null. */
  focusedId: string | null;
  selected: ReadonlySet<string>;
  /** The issue key showing in the peek pane, or null. */
  peekedKey: string | null;
  /** Moves the keyboard focus to a row. */
  focus: (id: string) => void;
  /** Toggles a row's selection, extending from the last one with `range`. */
  toggleSelected: (id: string, range: boolean) => void;
  /** Opens the issue in the peek pane. */
  peek: (issue: OrderedIssueRead) => void;
}

/** The view's shared state. Null outside an issue view. */
export const IssueViewEnvContext = createContext<IssueViewEnv | null>(null);

/** Reads the view's shared state. Throws outside an issue view. */
export const useIssueViewEnv = (): IssueViewEnv => {
  const env = useContext(IssueViewEnvContext);
  if (env === null) {
    throw new Error('useIssueViewEnv needs an IssueListView above it');
  }
  return env;
};
