/**
 * An issue list or board, worked from the keyboard the way an issue tracker
 * is worked in practice: j and k move, x selects, Shift extends, Enter opens,
 * Space peeks, and s, p, a, l and e change a property on the selection or
 * the focused issue. The keys go through the workspace shortcut registry, so
 * they stand down in text fields and dialogs, show in the help overlay, and
 * the property ones are offered as actions in the command palette.
 *
 * Space is the one key held locally, because the registry splits its keys on
 * whitespace and so cannot bind it.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { useNavigate } from 'react-router-dom';
import type { OrderedIssueRead } from '../../../api/issues';
import { NONE } from '../../../api/issues';
import { isModalOpen, isTypingTarget } from '../../../hooks/useCommandPalette';
import {
  useCreateIssue,
  type CreateIssueOptions,
} from '../../../hooks/useCreateIssue';
import type { IssueCollection } from '../../../hooks/useIssueCollection';
import { COLLECTION_LIMIT } from '../../../hooks/useIssueCollection';
import type { IssueContextState } from '../../../hooks/useIssueContext';
import { usePeekIssue } from '../../../hooks/usePeekIssue';
import { useShortcut } from '../../../hooks/useShortcuts';
import { errorMessage } from '../../../lib/errors';
import {
  groupIssues,
  sortIssues,
  statusGroupKey,
  type IssueGroup,
  type ViewState,
} from '../../../lib/issueView';
import { issuePath } from '../../../lib/paths';
import type { EstimateScale } from '../../../types/Api';
import { ErrorAlert } from '../../ui/alert';
import { Kbd } from '../../ui/badge';
import { Button } from '../../ui/button';
import EmptyState from '../../ui/empty-state';
import { SkeletonRows } from '../../ui/skeleton';
import BoardLayout from './BoardLayout';
import BulkBar from './BulkBar';
import { IssueViewEnvContext, type IssueViewEnv } from './IssueViewContext';
import ListRows, { type IssueSection } from './ListRows';
import PropertyCommand from './PropertyCommand';
import type { CommandProperty } from './propertyKeys';

/** Props for IssueListView. */
export interface IssueListViewProps {
  slug: string;
  state: ViewState;
  onStateChange: (state: ViewState) => void;
  collection: IssueCollection;
  lists: IssueContextState;
  scaleFor: (teamId: string) => EstimateScale;
  teamNameFor?: (teamId: string) => string | undefined;
  canEdit: boolean;
  /** The team a group's create button files into, when the view has one team. */
  createTeamId?: string | undefined;
  /** What an empty list says. */
  emptyMessage?: string;
}

/** The key and palette label of each property command. */
const PROPERTIES: { key: string; property: CommandProperty; label: string }[] =
  [
    { key: 's', property: 'status', label: 'Change status' },
    { key: 'p', property: 'priority', label: 'Change priority' },
    { key: 'a', property: 'assignee', label: 'Assign' },
    { key: 'l', property: 'labels', label: 'Change labels' },
    { key: 'e', property: 'estimate', label: 'Set estimate' },
  ];

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
  teamNameFor,
  canEdit,
  createTeamId,
  emptyMessage = 'No issues match this view.',
}) => {
  const navigate = useNavigate();
  const { peekIssue, peekedKey } = usePeekIssue();
  const creator = useCreateIssue();
  const { context, forTeam, createLabel } = lists;
  const { update, queryKey } = collection;

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [anchor, setAnchor] = useState<string | null>(null);
  const [command, setCommand] = useState<CommandProperty | null>(null);
  const scrollOnFocus = useRef(false);

  const sorted = useMemo(
    () => sortIssues(collection.issues, state.ordering),
    [collection.issues, state.ordering]
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

  const order = useMemo(() => {
    const seen = new Set<string>();
    const ids: string[] = [];
    const take = (issues: OrderedIssueRead[]): void => {
      for (const issue of issues) {
        if (seen.has(issue.id)) continue;
        seen.add(issue.id);
        ids.push(issue.id);
      }
    };
    if (state.layout === 'board' && state.subGroupBy !== 'none') {
      const field = state.groupBy === 'none' ? 'status' : state.groupBy;
      for (const lane of groupIssues(
        sorted,
        state.subGroupBy,
        context,
        false
      )) {
        if (collapsed.has(`lane/${lane.key}`)) continue;
        for (const column of groupIssues(lane.issues, field, context, false)) {
          take(column.issues);
        }
      }
      return ids;
    }
    for (const { group, subs } of sections) {
      if (state.layout === 'list' && collapsed.has(group.key)) continue;
      if (subs === null || state.layout === 'board') {
        take(group.issues);
        continue;
      }
      for (const sub of subs) {
        if (!collapsed.has(`${group.key}/${sub.key}`)) take(sub.issues);
      }
    }
    return ids;
  }, [
    sections,
    sorted,
    context,
    collapsed,
    state.layout,
    state.groupBy,
    state.subGroupBy,
  ]);

  const focused = focusedId !== null && byId.has(focusedId) ? focusedId : null;
  const liveSelected = useMemo(
    () => new Set([...selected].filter((id) => byId.has(id))),
    [selected, byId]
  );
  const targets = useMemo(() => {
    if (liveSelected.size > 0) {
      return order
        .flatMap((id) => (liveSelected.has(id) ? [byId.get(id)] : []))
        .filter((issue): issue is OrderedIssueRead => issue !== undefined);
    }
    const issue = focused === null ? undefined : byId.get(focused);
    return issue === undefined ? [] : [issue];
  }, [liveSelected, focused, order, byId]);

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
      peekIssue({ id: issue.id, key: issue.key });
    },
    [peekIssue]
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

  const move = (step: number, extend: boolean): void => {
    if (order.length === 0) return;
    const at = focused === null ? -1 : order.indexOf(focused);
    const nextIndex =
      at < 0
        ? step > 0
          ? 0
          : order.length - 1
        : Math.min(order.length - 1, Math.max(0, at + step));
    const next = order[nextIndex];
    if (next === undefined) return;
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
      if (issue !== undefined) void navigate(issuePath(slug, issue.key));
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

  const latest = useRef({ focused, byId, peek });
  latest.current = { focused, byId, peek };
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== ' ' || event.ctrlKey || event.metaKey || event.altKey)
        return;
      if (
        event.defaultPrevented ||
        isTypingTarget(event.target) ||
        isModalOpen()
      )
        return;
      const { focused: id, byId: rows, peek: show } = latest.current;
      const issue = id === null ? undefined : rows.get(id);
      if (issue === undefined) return;
      event.preventDefault();
      show(issue);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const onToggle = useCallback((key: string) => {
    setCollapsed((held) => {
      const next = new Set(held);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

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

  const createIn = useMemo(() => {
    if (!canEdit || !creator.canCreate) return undefined;
    return (group: IssueGroup, sub?: IssueGroup) => () => {
      creator.open({
        ...(createTeamId === undefined ? {} : { teamId: createTeamId }),
        ...presetFor(group),
        ...(sub === undefined ? {} : presetFor(sub)),
        onCreated: () => {
          invalidateQueries(queryKey);
        },
      });
    };
  }, [canEdit, creator, createTeamId, presetFor, queryKey]);

  const env = useMemo<IssueViewEnv>(
    () => ({
      slug,
      state,
      context,
      forTeam,
      scaleFor,
      ...(teamNameFor === undefined ? {} : { teamNameFor }),
      canEdit,
      update,
      createLabel,
      focusedId: focused,
      selected: liveSelected,
      peekedKey,
      focus: setFocusedId,
      toggleSelected,
      peek,
    }),
    [
      slug,
      state,
      context,
      forTeam,
      scaleFor,
      teamNameFor,
      canEdit,
      update,
      createLabel,
      focused,
      liveSelected,
      peekedKey,
      toggleSelected,
      peek,
    ]
  );

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
      {PROPERTIES.map(({ key, property, label }) => (
        <PropertyShortcut
          key={key}
          keys={key}
          label={label}
          enabled={canCommand}
          onRun={() => {
            setCommand(property);
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
      {command !== null && (
        <PropertyCommand
          property={command}
          issues={targets}
          onClose={() => {
            setCommand(null);
          }}
        />
      )}
      <BulkBar
        count={liveSelected.size}
        estimates={estimates}
        onProperty={setCommand}
        onClear={() => {
          setSelected(new Set());
          setAnchor(null);
        }}
      />
    </IssueViewEnvContext.Provider>
  );
};

export default IssueListView;
