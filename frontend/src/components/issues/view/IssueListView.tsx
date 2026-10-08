/**
 * An issue list or board, worked from the keyboard the way an issue tracker
 * is worked in practice: j and k move, x selects, Shift extends, Enter opens,
 * Space peeks, s, p, a, l, e, Shift+M, Shift+C, Shift+P and Shift+D change a
 * property on the selection or the focused issue, i assigns them to the
 * viewer or back off them, # archives or restores them, and Cmd or
 * Ctrl+Delete deletes them after a confirmation. On a board j and k stay in
 * the focused column, h and l or the side arrows cross to the next column
 * holding a card, and labels move to Shift+L. A right
 * click on a row or a card opens the same commands as a menu. Opening an
 * issue remembers the view's order, so the issue page can step through it.
 * The keys go through the workspace
 * shortcut registry, so they stand down in text fields and dialogs, show in
 * the help overlay, and the property ones are offered as actions in the
 * command palette.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { OrderedIssueRead } from '../../../api/issues';
import { NONE } from '../../../api/issues';
import {
  useCreateIssue,
  type CreateIssueOptions,
} from '../../../hooks/useCreateIssue';
import type { IssueCollection } from '../../../hooks/useIssueCollection';
import { useStoredSet } from '../../../hooks/useStoredSet';
import { COLLECTION_LIMIT } from '../../../hooks/useIssueCollection';
import {
  subjectOf,
  usePublishIssueSubject,
} from '../../../hooks/useIssueSubject';
import type { IssueContextState } from '../../../hooks/useIssueContext';
import { usePeekIssue } from '../../../hooks/usePeekIssue';
import { useShortcut } from '../../../hooks/useShortcuts';
import { errorMessage } from '../../../lib/errors';
import {
  FILTER_FIELDS,
  fieldsFor,
  filterValuesFor,
  groupIssues,
  hiddenColumnKey,
  narrowFilters,
  shownIssues,
  sortIssues,
  statusGroupKey,
  type FilterField,
  type IssueGroup,
  type ViewState,
  withLayout,
} from '../../../lib/issueView';
import {
  COPY_ISSUE_ID_KEYS,
  COPY_ISSUE_URL_KEYS,
  copyText,
  issueUrl,
} from '../../../lib/copyIssue';
import { allArchived } from '../../../lib/issueDisplay';
import { boardStep } from '../../../lib/boardNav';
import { rememberTrail } from '../../../lib/issueTrail';
import { issuePath } from '../../../lib/paths';
import type { EstimateOptions } from '../../../lib/validation';
import type { EstimateScale } from '../../../types/Api';
import { ErrorAlert } from '../../ui/alert';
import { Kbd } from '../../ui/badge';
import { Button } from '../../ui/button';
import EmptyState from '../../ui/empty-state';
import { SkeletonRows } from '../../ui/skeleton';
import ConfirmDeleteIssuesDialog from '../ConfirmDeleteIssuesDialog';
import BoardLayout from './BoardLayout';
import BulkBar from './BulkBar';
import { IssueViewEnvContext, type IssueViewEnv } from './IssueViewContext';
import IssueRowMenu from './IssueRowMenu';
import ListRows, { type IssueSection } from './ListRows';
import PropertyCommand from './PropertyCommand';
import {
  ARCHIVE_ISSUE_KEYS,
  DELETE_ISSUE_KEYS,
  propertyKeysFor,
  type CommandProperty,
} from './propertyKeys';

/** Props for IssueListView. */
export interface IssueListViewProps {
  slug: string;
  state: ViewState;
  onStateChange: (state: ViewState) => void;
  collection: IssueCollection;
  lists: IssueContextState;
  scaleFor: (teamId: string) => EstimateScale;
  estimateOptionsFor?: (teamId: string) => EstimateOptions;
  teamNameFor?: (teamId: string) => string | undefined;
  canEdit: boolean;
  /** The team a group's create button files into, when the view has one team. */
  createTeamId?: string | undefined;
  /** The project new issues are filed into, when the view is one project's. */
  createProjectId?: string | undefined;
  /** What an empty list says. */
  emptyMessage?: string;
  /**
   * Names the view for remembering folded groups and hidden board columns
   * across visits. Left out, they last only while the view is open.
   */
  collapseKey?: string | undefined;
  /**
   * The fields a chip click may filter on. Left out, every field the view's
   * filter menu offers.
   */
  filterFields?: readonly FilterField[] | undefined;
}

/** The palette label of each property command. */
const PROPERTIES: { property: CommandProperty; label: string }[] = [
  { property: 'status', label: 'Change status' },
  { property: 'priority', label: 'Change priority' },
  { property: 'assignee', label: 'Assign' },
  { property: 'labels', label: 'Change labels' },
  { property: 'estimate', label: 'Set estimate' },
  { property: 'milestone', label: 'Set milestone' },
  { property: 'cycle', label: 'Move to cycle' },
  { property: 'project', label: 'Move to project' },
  { property: 'dueDate', label: 'Set due date' },
];

/** A property command open on a set of issues, named by id. */
interface OpenCommand {
  property: CommandProperty;
  ids: string[];
}

/** The row menu open at the pointer, on a set of issues named by id. */
interface OpenMenu {
  x: number;
  y: number;
  ids: string[];
}

/** Binds one property key to opening its command, while it can act. */
const PropertyShortcut: React.FC<{
  keys: string;
  label: string;
  enabled: boolean;
  onRun: () => void;
}> = ({ keys, label, enabled, onRun }) => {
  useShortcut({ keys, label, scope: 'issue', enabled, handler: onRun });
  return null;
};

/** The view. */
export const IssueListView: React.FC<IssueListViewProps> = ({
  slug,
  state,
  onStateChange,
  collection,
  lists,
  scaleFor,
  estimateOptionsFor,
  teamNameFor,
  canEdit,
  createTeamId,
  createProjectId,
  emptyMessage = 'No issues match this view.',
  collapseKey,
  filterFields,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { peekIssue, peekedKey } = usePeekIssue();
  const creator = useCreateIssue();
  const { context, forTeam, createLabel } = lists;
  const { update, queryKey } = collection;

  const [collapsed, onToggle] = useStoredSet(
    collapseKey === undefined
      ? undefined
      : `standupless.view.collapsed.${collapseKey}`
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [anchor, setAnchor] = useState<string | null>(null);
  const [command, setCommand] = useState<OpenCommand | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [deleting, setDeleting] = useState<OrderedIssueRead[] | null>(null);
  const scrollOnFocus = useRef(false);

  const { showSubIssues, showCompleted } = state;
  const sorted = useMemo(
    () =>
      sortIssues(
        shownIssues(
          collection.issues,
          { showSubIssues, showCompleted },
          context
        ),
        state.ordering
      ),
    [collection.issues, state.ordering, showSubIssues, showCompleted, context]
  );
  const byId = useMemo(
    () => new Map(sorted.map((issue) => [issue.id, issue])),
    [sorted]
  );

  const sections = useMemo<IssueSection[]>(() => {
    const field =
      state.layout === 'board' && state.groupBy === 'none'
        ? 'status'
        : state.groupBy;
    return groupIssues(sorted, field, context, state.showEmpty).map(
      (group) => ({
        group,
        subs:
          state.subGroupBy === 'none' || field === 'none'
            ? null
            : groupIssues(group.issues, state.subGroupBy, context, false),
      })
    );
  }, [
    sorted,
    context,
    state.groupBy,
    state.subGroupBy,
    state.showEmpty,
    state.layout,
  ]);

  const board = useMemo<string[][][] | null>(() => {
    if (state.layout !== 'board') return null;
    const seen = new Set<string>();
    const take = (issues: OrderedIssueRead[]): string[] =>
      issues.flatMap((issue) => {
        if (seen.has(issue.id)) return [];
        seen.add(issue.id);
        return [issue.id];
      });
    if (state.subGroupBy !== 'none') {
      const field = state.groupBy === 'none' ? 'status' : state.groupBy;
      return groupIssues(sorted, state.subGroupBy, context, false)
        .filter((lane) => !collapsed.has(`lane/${lane.key}`))
        .map((lane) =>
          groupIssues(lane.issues, field, context, false)
            .filter((column) => !collapsed.has(hiddenColumnKey(column.key)))
            .map((column) => take(column.issues))
        );
    }
    return [
      sections
        .filter(({ group }) => !collapsed.has(hiddenColumnKey(group.key)))
        .map(({ group }) => take(group.issues)),
    ];
  }, [
    sections,
    sorted,
    context,
    collapsed,
    state.layout,
    state.groupBy,
    state.subGroupBy,
  ]);

  const order = useMemo(() => {
    if (board !== null) return board.flat(2);
    const seen = new Set<string>();
    const ids: string[] = [];
    const take = (issues: OrderedIssueRead[]): void => {
      for (const issue of issues) {
        if (seen.has(issue.id)) continue;
        seen.add(issue.id);
        ids.push(issue.id);
      }
    };
    for (const { group, subs } of sections) {
      if (collapsed.has(group.key)) continue;
      if (subs === null) {
        take(group.issues);
        continue;
      }
      for (const sub of subs) {
        if (!collapsed.has(`${group.key}/${sub.key}`)) take(sub.issues);
      }
    }
    return ids;
  }, [board, sections, collapsed]);

  const from = `${location.pathname}${location.search}`;
  const rememberOrder = useCallback(() => {
    rememberTrail({
      slug,
      keys: order.flatMap((id) => {
        const issue = byId.get(id);
        return issue === undefined ? [] : [issue.key];
      }),
      from,
    });
  }, [slug, order, byId, from]);
  const openIssue = (issue: OrderedIssueRead): void => {
    rememberOrder();
    void navigate(issuePath(slug, issue.key));
  };

  const focused = focusedId !== null && byId.has(focusedId) ? focusedId : null;
  const liveSelected = useMemo(
    () => new Set([...selected].filter((id) => byId.has(id))),
    [selected, byId]
  );
  const targets = useMemo(() => {
    if (liveSelected.size > 0) {
      const shown = new Set(order);
      return [
        ...order.flatMap((id) => (liveSelected.has(id) ? [byId.get(id)] : [])),
        ...sorted.filter(
          (issue) => liveSelected.has(issue.id) && !shown.has(issue.id)
        ),
      ].filter((issue): issue is OrderedIssueRead => issue !== undefined);
    }
    const issue = focused === null ? undefined : byId.get(focused);
    return issue === undefined ? [] : [issue];
  }, [liveSelected, focused, order, byId, sorted]);

  useEffect(() => {
    if (!scrollOnFocus.current || focused === null) return;
    scrollOnFocus.current = false;
    const row = document.querySelector<HTMLElement>(
      `[data-row-id="${CSS.escape(focused)}"]`
    );
    if (typeof row?.scrollIntoView === 'function')
      row.scrollIntoView({ block: 'nearest' });
  }, [focused]);

  const lastPeeked = useRef<string | null>(peekedKey);
  useEffect(() => {
    if (lastPeeked.current !== null && lastPeeked.current !== peekedKey) {
      invalidateQueries(queryKey);
    }
    lastPeeked.current = peekedKey;
  }, [peekedKey, queryKey]);

  const peek = useCallback(
    (issue: OrderedIssueRead) => {
      rememberOrder();
      peekIssue({ id: issue.id, key: issue.key });
    },
    [peekIssue, rememberOrder]
  );

  const toggleSelected = useCallback(
    (id: string, range: boolean) => {
      if (range && anchor !== null && order.includes(anchor)) {
        const from = order.indexOf(anchor);
        const to = order.indexOf(id);
        const span = order.slice(Math.min(from, to), Math.max(from, to) + 1);
        setSelected((held) => new Set([...held, ...span]));
      } else {
        setSelected((held) => {
          const next = new Set(held);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        setAnchor(id);
      }
      setFocusedId(id);
    },
    [anchor, order]
  );

  const selectMany = useCallback((ids: readonly string[], on: boolean) => {
    setSelected((held) => {
      const next = new Set(held);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const focusOn = (next: string, extend: boolean): void => {
    if (extend) {
      const start = focused ?? next;
      setSelected((held) => new Set([...held, start, next]));
      if (anchor === null) setAnchor(start);
    }
    scrollOnFocus.current = true;
    setFocusedId(next);
    const issue = byId.get(next);
    if (peekedKey !== null && issue !== undefined && issue.key !== peekedKey)
      peek(issue);
  };

  const move = (step: number, extend: boolean): void => {
    if (order.length === 0) return;
    if (board !== null) {
      const next = boardStep(board, focused, step > 0 ? 'down' : 'up');
      if (next !== undefined) focusOn(next, extend);
      return;
    }
    const at = focused === null ? -1 : order.indexOf(focused);
    const nextIndex =
      at < 0
        ? step > 0
          ? 0
          : order.length - 1
        : Math.min(order.length - 1, Math.max(0, at + step));
    const next = order[nextIndex];
    if (next !== undefined) focusOn(next, extend);
  };

  const moveAcross = (direction: 'left' | 'right'): void => {
    if (board === null) return;
    const next = boardStep(board, focused, direction);
    if (next !== undefined) focusOn(next, false);
  };

  const hasRows = order.length > 0;
  useShortcut({
    keys: 'j',
    label: 'Next issue',
    group: 'List',
    enabled: hasRows,
    handler: () => {
      move(1, false);
    },
  });
  useShortcut({
    keys: 'k',
    label: 'Previous issue',
    group: 'List',
    enabled: hasRows,
    handler: () => {
      move(-1, false);
    },
  });
  useShortcut({
    keys: 'shift+j',
    label: 'Extend selection down',
    group: 'List',
    enabled: hasRows,
    handler: () => {
      move(1, true);
    },
  });
  useShortcut({
    keys: 'shift+k',
    label: 'Extend selection up',
    group: 'List',
    enabled: hasRows,
    handler: () => {
      move(-1, true);
    },
  });
  useShortcut({
    keys: 'arrowdown',
    label: 'Next issue',
    group: 'List',
    enabled: hasRows,
    handler: (event) => {
      move(1, event?.shiftKey === true);
    },
  });
  useShortcut({
    keys: 'arrowup',
    label: 'Previous issue',
    group: 'List',
    enabled: hasRows,
    handler: (event) => {
      move(-1, event?.shiftKey === true);
    },
  });
  const onBoard = board !== null && hasRows;
  useShortcut({
    keys: 'h',
    label: 'Previous column',
    scope: 'page',
    group: 'Board',
    enabled: onBoard,
    handler: () => {
      moveAcross('left');
    },
  });
  useShortcut({
    keys: 'l',
    label: 'Next column',
    scope: 'page',
    group: 'Board',
    enabled: onBoard,
    handler: () => {
      moveAcross('right');
    },
  });
  useShortcut({
    keys: 'arrowleft',
    label: 'Previous column',
    group: 'Board',
    enabled: onBoard,
    handler: () => {
      moveAcross('left');
    },
  });
  useShortcut({
    keys: 'arrowright',
    label: 'Next column',
    group: 'Board',
    enabled: onBoard,
    handler: () => {
      moveAcross('right');
    },
  });
  useShortcut({
    keys: 'x',
    label: 'Select issue',
    scope: 'issue',
    group: 'List',
    enabled: focused !== null,
    handler: () => {
      if (focused !== null) toggleSelected(focused, false);
    },
  });
  useShortcut({
    keys: 'mod+a',
    label: 'Select all',
    group: 'List',
    enabled: hasRows,
    handler: () => {
      setSelected(new Set(order));
    },
  });
  useShortcut({
    keys: 'enter',
    label: 'Open issue',
    group: 'List',
    enabled: focused !== null,
    handler: () => {
      const issue = focused === null ? undefined : byId.get(focused);
      if (issue !== undefined) openIssue(issue);
    },
  });
  useShortcut({
    keys: 'escape',
    label: 'Clear selection',
    group: 'List',
    enabled: liveSelected.size > 0,
    handler: () => {
      setSelected(new Set());
      setAnchor(null);
    },
  });
  const canCommand = canEdit && targets.length > 0;
  const propertyKeys = propertyKeysFor(state.layout);
  const me = context.people.find(
    (person) => person.user_id === context.currentUserId
  );
  const openCommand = (
    property: CommandProperty,
    issues: readonly OrderedIssueRead[]
  ): void => {
    setCommand({ property, ids: issues.map((issue) => issue.id) });
  };
  const assignToMe = (
    issues: readonly OrderedIssueRead[],
    toggle = false
  ): void => {
    if (me === undefined) return;
    const mine =
      toggle && issues.every((issue) => issue.assignee_id === me.user_id);
    update(
      issues.map((issue) => issue.id),
      { assignee_id: mine ? null : me.user_id }
    );
  };
  const copyIds = (issues: readonly OrderedIssueRead[]): void => {
    copyText(
      issues.map((issue) => issue.key).join(', '),
      issues.length === 1 ? 'Issue ID copied' : 'Issue IDs copied'
    );
  };
  const copyUrls = (issues: readonly OrderedIssueRead[]): void => {
    copyText(
      issues.map((issue) => issueUrl(slug, issue.key)).join('\n'),
      issues.length === 1 ? 'Issue URL copied' : 'Issue URLs copied'
    );
  };
  const remove = collection.remove;
  const archive = collection.archive;
  const toggleArchive = (issues: readonly OrderedIssueRead[]): void => {
    if (archive === undefined || issues.length === 0) return;
    const restore = allArchived(issues);
    const ids = issues.map((issue) => issue.id);
    const hides =
      collection.archivedOnly === true
        ? restore
        : !restore && !state.showArchived;
    if (hides) {
      setSelected((held) => {
        const next = new Set(held);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
    void archive(ids, restore);
  };
  useShortcut({
    keys: 'i',
    label: 'Assign to me',
    scope: 'issue',
    enabled: canCommand && me !== undefined,
    handler: () => {
      assignToMe(targets, true);
    },
  });
  useShortcut({
    keys: COPY_ISSUE_ID_KEYS,
    label: 'Copy issue ID',
    scope: 'issue',
    enabled: targets.length > 0,
    handler: () => {
      copyIds(targets);
    },
  });
  useShortcut({
    keys: COPY_ISSUE_URL_KEYS,
    label: 'Copy issue URL',
    scope: 'issue',
    enabled: targets.length > 0,
    handler: () => {
      copyUrls(targets);
    },
  });
  useShortcut({
    keys: ARCHIVE_ISSUE_KEYS,
    label: allArchived(targets) ? 'Restore issue' : 'Archive issue',
    scope: 'issue',
    enabled: canCommand && archive !== undefined,
    handler: () => {
      toggleArchive(targets);
    },
  });
  useShortcut({
    keys: DELETE_ISSUE_KEYS,
    label: 'Delete issue',
    scope: 'issue',
    enabled: canCommand && remove !== undefined,
    handler: (event) => {
      event?.preventDefault();
      setDeleting(targets);
    },
  });
  usePublishIssueSubject(subjectOf(targets));
  useShortcut({
    keys: 'mod+b',
    label: 'Toggle list and board',
    group: 'List',
    handler: () => {
      onStateChange({
        ...state,
        ...withLayout(state, state.layout === 'board' ? 'list' : 'board'),
      });
    },
  });

  useShortcut({
    keys: 'space',
    label: 'Peek issue',
    group: 'List',
    enabled: focused !== null,
    handler: () => {
      const issue = focused === null ? undefined : byId.get(focused);
      if (issue !== undefined) peek(issue);
    },
  });

  const presetFor = useCallback(
    (group: IssueGroup): Partial<CreateIssueOptions> => {
      if (group.field === 'status' && createTeamId !== undefined) {
        const status = context.statuses.find(
          (item) =>
            statusGroupKey(item) === group.key &&
            (item.team_id === undefined || item.team_id === createTeamId)
        );
        return status === undefined ? {} : { statusId: status.id };
      }
      if (
        group.field === 'assignee' &&
        group.key !== NONE &&
        context.people.some((person) => person.user_id === group.key)
      ) {
        return { assigneeId: group.key };
      }
      return {};
    },
    [context, createTeamId]
  );

  const openMenu = useCallback(
    (issue: OrderedIssueRead, x: number, y: number) => {
      const ids = liveSelected.has(issue.id)
        ? order.filter((id) => liveSelected.has(id))
        : [issue.id];
      setFocusedId(issue.id);
      setMenu({ x, y, ids });
    },
    [liveSelected, order]
  );
  const closeMenu = useCallback(() => {
    setMenu(null);
  }, []);

  const createIn = useMemo(() => {
    if (!canEdit || !creator.canCreate) return undefined;
    return (group: IssueGroup, sub?: IssueGroup) => () => {
      creator.open({
        ...(createTeamId === undefined ? {} : { teamId: createTeamId }),
        ...(createProjectId === undefined
          ? {}
          : { projectId: createProjectId }),
        ...presetFor(group),
        ...(sub === undefined ? {} : presetFor(sub)),
        onCreated: () => {
          invalidateQueries(queryKey);
        },
      });
    };
  }, [canEdit, creator, createTeamId, createProjectId, presetFor, queryKey]);

  const filterFor = useCallback(
    (field: FilterField): ((value: string) => void) | undefined => {
      const allowed = filterFields ?? fieldsFor(FILTER_FIELDS, context);
      if (!allowed.includes(field)) return undefined;
      return (value: string) => {
        onStateChange({
          ...state,
          filters: narrowFilters(
            state.filters,
            field,
            filterValuesFor(field, value, context)
          ),
        });
      };
    },
    [filterFields, context, onStateChange, state]
  );

  const env = useMemo<IssueViewEnv>(
    () => ({
      slug,
      state,
      context,
      forTeam,
      scaleFor,
      ...(estimateOptionsFor === undefined ? {} : { estimateOptionsFor }),
      ...(teamNameFor === undefined ? {} : { teamNameFor }),
      canEdit,
      update,
      createLabel,
      focusedId: focused,
      selected: liveSelected,
      peekedKey,
      focus: setFocusedId,
      toggleSelected,
      selectMany,
      peek,
      openMenu,
      onOpen: rememberOrder,
      filterFor,
    }),
    [
      slug,
      state,
      context,
      forTeam,
      scaleFor,
      estimateOptionsFor,
      teamNameFor,
      canEdit,
      update,
      createLabel,
      focused,
      liveSelected,
      peekedKey,
      toggleSelected,
      selectMany,
      peek,
      openMenu,
      rememberOrder,
      filterFor,
    ]
  );

  const resolve = (ids: readonly string[]): OrderedIssueRead[] =>
    ids
      .map((id) => byId.get(id))
      .filter((issue): issue is OrderedIssueRead => issue !== undefined);
  const commandIssues = command === null ? [] : resolve(command.ids);
  const menuIssues = menu === null ? [] : resolve(menu.ids);
  const menuSingle = menuIssues.length === 1 ? menuIssues[0] : undefined;

  const loading =
    (collection.isLoading || lists.isLoading) && collection.issues.length === 0;
  const estimates = targets.some((issue) => scaleFor(issue.team_id) !== 'off');

  let body: React.ReactNode;
  if (loading) {
    body = (
      <div className="px-4 py-3 lg:px-6">
        <SkeletonRows count={8} label="Loading issues" />
      </div>
    );
  } else if (
    collection.error !== null &&
    collection.error !== undefined &&
    collection.issues.length === 0
  ) {
    body = (
      <div className="px-4 py-4 lg:px-6">
        <ErrorAlert
          message={errorMessage(
            collection.error,
            'Could not load these issues.'
          )}
        />
      </div>
    );
  } else if (sorted.length === 0 && state.layout === 'list') {
    const firstIssue =
      createTeamId !== undefined &&
      createProjectId === undefined &&
      canEdit &&
      creator.canCreate &&
      state.filters.length === 0 &&
      state.q.trim() === '';
    body = firstIssue ? (
      <EmptyState
        message="No issues in this team yet. Create the first one to get started."
        className="m-6"
        action={
          <div className="flex flex-col items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => creator.open({ teamId: createTeamId })}
            >
              Create issue
            </Button>
            <span className="text-xs text-text-faint">
              or press <Kbd>C</Kbd>
            </span>
          </div>
        }
      />
    ) : (
      <EmptyState message={emptyMessage} className="m-6" />
    );
  } else if (state.layout === 'board') {
    body = (
      <BoardLayout
        issues={sorted}
        collapsed={collapsed}
        onToggle={onToggle}
        onStateChange={onStateChange}
        createIn={createIn}
      />
    );
  } else {
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto pb-20">
        <ListRows
          sections={sections}
          collapsed={collapsed}
          onToggle={onToggle}
          createIn={createIn}
        />
        {collection.truncated && (
          <p className="px-4 py-3 text-xs text-text-muted lg:px-6">
            Showing the first {COLLECTION_LIMIT} issues. Narrow the filters to
            see the rest.
          </p>
        )}
      </div>
    );
  }

  return (
    <IssueViewEnvContext.Provider value={env}>
      {PROPERTIES.map(({ property, label }) => (
        <PropertyShortcut
          key={property}
          keys={propertyKeys[property]}
          label={label}
          enabled={
            canCommand &&
            (property !== 'milestone' || context.milestones !== undefined)
          }
          onRun={() => {
            openCommand(property, targets);
          }}
        />
      ))}
      <div
        className="flex min-h-0 flex-1 flex-col"
        onMouseLeave={() => {
          if (peekedKey === null) setFocusedId(null);
        }}
      >
        {body}
      </div>
      {command !== null && commandIssues.length > 0 && (
        <PropertyCommand
          property={command.property}
          issues={commandIssues}
          onClose={() => {
            setCommand(null);
          }}
        />
      )}
      {deleting !== null && remove !== undefined && (
        <ConfirmDeleteIssuesDialog
          issues={deleting}
          onClose={() => {
            setDeleting(null);
          }}
          onConfirm={async () => {
            const ids = deleting.map((issue) => issue.id);
            setSelected((held) => {
              const next = new Set(held);
              for (const id of ids) next.delete(id);
              return next;
            });
            await remove(ids);
          }}
        />
      )}
      {menu !== null && menuIssues.length > 0 && (
        <IssueRowMenu
          x={menu.x}
          y={menu.y}
          issues={menuIssues}
          canEdit={canEdit}
          estimates={menuIssues.some(
            (issue) => scaleFor(issue.team_id) !== 'off'
          )}
          milestones={context.milestones !== undefined}
          onProperty={(property) => {
            openCommand(property, menuIssues);
          }}
          onAssignToMe={
            me === undefined
              ? undefined
              : () => {
                  assignToMe(menuIssues);
                }
          }
          onCopyId={() => {
            copyIds(menuIssues);
          }}
          onCopyUrl={() => {
            copyUrls(menuIssues);
          }}
          onOpen={
            menuSingle === undefined
              ? undefined
              : () => {
                  openIssue(menuSingle);
                }
          }
          onPeek={
            menuSingle === undefined
              ? undefined
              : () => {
                  peek(menuSingle);
                }
          }
          onArchive={
            archive === undefined
              ? undefined
              : () => {
                  toggleArchive(menuIssues);
                }
          }
          onDelete={
            remove === undefined
              ? undefined
              : () => {
                  setDeleting(menuIssues);
                }
          }
          onClose={closeMenu}
          keys={propertyKeys}
        />
      )}
      <BulkBar
        count={liveSelected.size}
        estimates={estimates}
        milestones={context.milestones !== undefined}
        archived={allArchived(targets)}
        keys={propertyKeys}
        onProperty={(property) => {
          openCommand(property, targets);
        }}
        onArchive={
          canEdit && archive !== undefined
            ? () => {
                toggleArchive(targets);
              }
            : undefined
        }
        onDelete={
          canEdit && remove !== undefined
            ? () => {
                setDeleting(targets);
              }
            : undefined
        }
        onClear={() => {
          setSelected(new Set());
          setAnchor(null);
        }}
      />
    </IssueViewEnvContext.Provider>
  );
};

export default IssueListView;
