/**
 * What every row, card and header of one issue view reads: the resolved
 * lists, the display state, the write path and the selection. Held in a
 * context so a row nested two groups deep does not take a dozen props
 * threaded through each layer between it and the view.
 */

import { createContext, useContext, useSyncExternalStore } from 'react';
import type { OrderedIssueRead } from '../../../api/issues';
import type { IssueWrite } from '../../../hooks/useOptimisticIssues';
import type { ParentRef } from '../../../lib/issueTree';
import type {
  CustomerMove,
  FilterField,
  IssueContext,
  ViewState,
} from '../../../lib/issueView';
import type { EstimateOptions } from '../../../lib/validation';
import type {
  EstimateScale,
  LabelRead,
  MilestoneRead,
} from '../../../types/Api';

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
  /** Whether an issue's team counts an unestimated issue as one point. Unset counts none. */
  countsUnestimated?: ((teamId: string) => boolean) | undefined;
  /** The extended and zero toggles of an issue's team. Unset offers neither. */
  estimateOptionsFor?: (teamId: string) => EstimateOptions;
  /** The team name shown on rows of a view that spans teams. */
  teamNameFor?: (teamId: string) => string | undefined;
  canEdit: boolean;
  /**
   * Whether the viewer may edit one issue, read from its team's role. Unset
   * leaves every issue to `canEdit`.
   */
  canEditIssue?: ((issue: OrderedIssueRead) => boolean) | undefined;
  update: IssueWrite;
  /**
   * Files and withdraws customer requests for a drop between customer
   * columns. Unset where the list cannot write requests, which refuses it.
   */
  moveCustomer?: (issue: OrderedIssueRead, move: CustomerMove) => void;
  createLabel: (teamId: string, name: string) => Promise<LabelRead | null>;
  /**
   * The row the keyboard sits on, or null. Left out by a view that publishes
   * it through {@link RowFocusContext} instead, so a pointer sweeping down a
   * long list does not hand every row a new env.
   */
  focusedId?: string | null;
  selected: ReadonlySet<string>;
  /** False for a list that selects nothing, which draws no checkboxes. */
  selectable?: boolean;
  /**
   * The issue key showing in the peek pane, or null. Left out by a view that
   * publishes it through {@link RowFocusContext}.
   */
  peekedKey?: string | null;
  /** Moves the keyboard focus to a row. */
  focus: (id: string) => void;
  /** Toggles a row's selection, extending from the last one with `range`. */
  toggleSelected: (id: string, range: boolean) => void;
  /** Adds every issue named to the selection, or removes them all. */
  selectMany?: (ids: readonly string[], on: boolean) => void;
  /** Opens the issue in the peek pane. */
  peek: (issue: OrderedIssueRead) => void;
  /** Opens the row menu for an issue at the pointer, where the view has one. */
  openMenu?: (issue: OrderedIssueRead, x: number, y: number) => void;
  /** Opens the status picker for one issue, as a swipe right on a touch row does. */
  openStatus?: ((issue: OrderedIssueRead) => void) | undefined;
  /**
   * Opens the quick menu of assign to me, priority and a reminder for one
   * issue at a point, as a swipe left on a touch row does.
   */
  openQuickMenu?:
    ((issue: OrderedIssueRead, x: number, y: number) => void) | undefined;
  /** Remembers the view's order as an issue opens, where the view tracks it. */
  onOpen?: () => void;
  /**
   * Narrows the view to one value of a field, as a chip click does. Undefined
   * for a field the view cannot filter on, where the chip stays inert.
   */
  filterFor?: (field: FilterField) => ((value: string) => void) | undefined;
  /**
   * The milestones the milestone property names. A project's own list has
   * them in its context; a list elsewhere reads them from each project it
   * knows while the property shows.
   */
  milestones?: MilestoneRead[] | undefined;
  /**
   * The parent a sub-issue names, from the loaded issues or the list route's
   * parent fields. Unset reads the parent fields alone.
   */
  parentOf?: (issue: OrderedIssueRead) => ParentRef | undefined;
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

/**
 * The keyboard focus and the peeked issue of one view, held outside the env so
 * each row subscribes to whether it is the one marked. Moving the focus then
 * re-renders the row it left and the row it reached, not every row in the view.
 */
export interface RowFocusStore {
  subscribe: (listener: () => void) => () => void;
  focusedId: () => string | null;
  peekedKey: () => string | null;
  /** Sets both marks and tells the subscribers when either changed. */
  publish: (focusedId: string | null, peekedKey: string | null) => void;
}

/** A focus store starting from the given marks. */
export const createRowFocusStore = (
  focusedId: string | null,
  peekedKey: string | null
): RowFocusStore => {
  let focused = focusedId;
  let peeked = peekedKey;
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    focusedId: () => focused,
    peekedKey: () => peeked,
    publish: (nextFocused, nextPeeked) => {
      if (nextFocused === focused && nextPeeked === peeked) return;
      focused = nextFocused;
      peeked = nextPeeked;
      for (const listener of listeners) listener();
    },
  };
};

/** The view's focus store. Null where the env carries the marks itself. */
export const RowFocusContext = createContext<RowFocusStore | null>(null);

/** A subscription for a view with no focus store, which never changes. */
const noSubscribe = (): (() => void) => () => undefined;

/** Whether one row is the focused row and whether it is the peeked issue. */
export interface RowFocus {
  focused: boolean;
  peeked: boolean;
}

/**
 * Reads whether one issue's row holds the keyboard focus or the peek, from
 * the view's focus store when it has one and from the env otherwise. Each
 * answer is a boolean, so a row re-renders only when its own mark flips.
 */
export const useRowFocus = (issue: { id: string; key: string }): RowFocus => {
  const store = useContext(RowFocusContext);
  const env = useIssueViewEnv();
  const subscribe = store?.subscribe ?? noSubscribe;
  const isFocused = (): boolean =>
    (store === null ? (env.focusedId ?? null) : store.focusedId()) === issue.id;
  const isPeeked = (): boolean =>
    (store === null ? (env.peekedKey ?? null) : store.peekedKey()) ===
    issue.key;
  const focused = useSyncExternalStore(subscribe, isFocused, isFocused);
  const peeked = useSyncExternalStore(subscribe, isPeeked, isPeeked);
  return { focused, peeked };
};
