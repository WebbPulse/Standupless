/**
 * The signed in person's own issues across the workspace, under four tabs
 * like Linear's. Assigned (`assignee_id=me`), Created (`creator_id=me`) and
 * Subscribed (`subscriber_id=me`) draw the same grouped list or board as a
 * team's issues, resolved server side from a keyed index across every team
 * the caller belongs to. Activity lists the issues the caller last changed or
 * commented on as the same keyboard list, one row per issue ordered by their
 * latest action on it, which each row names beside its title, paging on as
 * the list scrolls. The tab lives in the URL, so a link lands on it, and the
 * number keys switch tabs while the page is open.
 * Assigned opens grouped by Focus, as Linear's does, and is the only list
 * that offers that grouping.
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ME,
  type IssueListFilters,
  type OrderedIssueRead,
} from '../../api/issues';
import IssueViewPage from '../../components/issues/view/IssueViewPage';
import { ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
import EmptyState from '../../components/ui/empty-state';
import RelativeTime from '../../components/ui/relative-time';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import {
  useTouchedIssues,
  type MemberActivity,
} from '../../hooks/useMemberActivity';
import {
  memberAction,
  useMemberActivityContext,
} from '../../hooks/useMemberActivityContext';
import { useShortcut, type ShortcutDefinition } from '../../hooks/useShortcuts';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { FOCUS_FIELD } from '../../lib/focusGrouping';
import {
  defaultViewState,
  type FilterField,
  type ViewState,
} from '../../lib/issueView';
import type { TeamRead, WorkspaceRead } from '../../types/Api';

/** Which of the caller's relationships to an issue the page lists. */
export type MyIssuesTab = 'assigned' | 'created' | 'subscribed' | 'activity';

/** The tabs that list issues through the shared issue view. */
type IssueTab = Exclude<MyIssuesTab, 'activity'>;

/** The URL parameter holding the tab; absent means Assigned. */
export const TAB_PARAM = 'tab';

/** What each tab reads, labels and says when empty. */
interface TabSpec {
  label: string;
  scope: IssueListFilters;
  hidden: FilterField[];
  empty: string;
  /** True for the tab that offers the Focus grouping and opens on it. */
  focus?: boolean;
}

/** The tabs in the order they show. The assignee filter is hidden where the tab fixes it. */
const TABS: Record<IssueTab, TabSpec> = {
  assigned: {
    label: 'Assigned',
    scope: { assignee_id: ME },
    hidden: ['assignee'],
    empty: 'Nothing is assigned to you right now.',
    focus: true,
  },
  created: {
    label: 'Created',
    scope: { creator_id: ME },
    hidden: [],
    empty: 'You have not created any issues yet.',
  },
  subscribed: {
    label: 'Subscribed',
    scope: { subscriber_id: ME },
    hidden: [],
    empty: 'You are not subscribed to any issues.',
  },
};

/** What the Activity tab says when the caller has done nothing yet. */
export const ACTIVITY_EMPTY =
  'Issues you change or comment on will show up here.';

/** The most issues the Activity tab lists, the most ids one list read names. */
export const ACTIVITY_LIMIT = 100;

/** An id no issue holds, so an empty id scope reads nothing rather than everything. */
const UNMATCHED_ISSUE_ID = '-';

/** The settings the Activity tab opens with: one ungrouped list in activity order. */
export const activityBase = (): ViewState => ({
  ...defaultViewState('list'),
  groupBy: 'none',
  ordering: 'manual',
});

/** Every tab's label, in the order the switch shows them. */
const TAB_LABELS: Record<MyIssuesTab, string> = {
  assigned: TABS.assigned.label,
  created: TABS.created.label,
  subscribed: TABS.subscribed.label,
  activity: 'Activity',
};

const TAB_ORDER: MyIssuesTab[] = [
  'assigned',
  'created',
  'subscribed',
  'activity',
];

/** The settings a tab opens with: the list default, grouped by Focus where the tab offers it. */
export const tabBase = (tab: IssueTab): ViewState => {
  const base = defaultViewState('list');
  return TABS[tab].focus === true ? { ...base, groupBy: FOCUS_FIELD } : base;
};

/** The address of a tab, relative to the page. */
const tabSearch = (tab: MyIssuesTab): string =>
  tab === 'assigned' ? '' : `?${TAB_PARAM}=${tab}`;

/** Reads the tab from the URL, falling back to Assigned for anything unknown. */
const readTab = (value: string | null): MyIssuesTab =>
  value !== null && (TAB_ORDER as string[]).includes(value)
    ? (value as MyIssuesTab)
    : 'assigned';

const tabClass = (active: boolean): string =>
  cn(
    'flex h-7 items-center rounded-sm px-2.5 text-sm font-medium whitespace-nowrap transition-colors duration-100 pointer-coarse:h-10',
    'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
    active ? 'bg-raised text-text' : 'text-text-muted hover:text-text'
  );

/**
 * The Assigned, Created, Subscribed and Activity switch. Links rather than
 * buttons, so each tab is an address; switching starts the new tab from its
 * own defaults.
 */
const MyIssuesTabs: React.FC<{ current: MyIssuesTab }> = ({ current }) => (
  <nav aria-label="My issues" className="flex items-center gap-1">
    {TAB_ORDER.map((tab) => (
      <Link
        key={tab}
        to={{ search: tabSearch(tab) }}
        className={tabClass(current === tab)}
        {...(current === tab ? { 'aria-current': 'page' as const } : {})}
      >
        {TAB_LABELS[tab]}
      </Link>
    ))}
  </nav>
);

/** Binds 1 to 4 to the tabs in order, so the help sheet lists each one. */
const useTabShortcuts = (): void => {
  const navigate = useNavigate();
  const bind = (tab: MyIssuesTab, index: number): ShortcutDefinition => ({
    keys: String(index + 1),
    label: `Show ${TAB_LABELS[tab].toLowerCase()}`,
    scope: 'page',
    group: 'My issues',
    handler: () => {
      void navigate({ search: tabSearch(tab) });
    },
  });
  useShortcut(bind('assigned', 0));
  useShortcut(bind('created', 1));
  useShortcut(bind('subscribed', 2));
  useShortcut(bind('activity', 3));
};

/**
 * The foot of the Activity list: reads the next page once it scrolls into
 * view, with a button for anyone who would rather ask, and says when the list
 * has reached its ceiling.
 */
const ActivityPager: React.FC<{ feed: MemberActivity; capped: boolean }> = ({
  feed,
  capped,
}) => {
  const sentinel = useRef<HTMLDivElement | null>(null);
  const { hasMore, isPaging, loadMore } = feed;
  const wanted = hasMore && !capped;
  useEffect(() => {
    const node = sentinel.current;
    if (
      !wanted ||
      isPaging ||
      node === null ||
      typeof IntersectionObserver === 'undefined'
    )
      return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [wanted, isPaging, loadMore]);

  if (capped) {
    return (
      <p className="px-4 py-3 text-xs text-text-muted lg:px-6">
        Showing the {ACTIVITY_LIMIT} issues you touched most recently.
      </p>
    );
  }
  if (!hasMore) return null;
  return (
    <div ref={sentinel} className="flex justify-center px-4 py-3">
      <Button
        variant="secondary"
        size="sm"
        disabled={isPaging}
        onClick={loadMore}
      >
        {isPaging ? 'Loading' : 'Load more'}
      </Button>
    </div>
  );
};

/** Props for {@link ActivityList}. */
interface ActivityListProps {
  workspace: WorkspaceRead;
  teams: TeamRead[];
  canEdit: boolean;
}

/**
 * The Activity tab: the issues the caller touched as a full issue list, so
 * j and k, selection, the bulk bar and the property menus work as on the
 * other tabs. The rows are read by id in the order of the caller's latest
 * action, and each names that action and when.
 */
const ActivityList: React.FC<ActivityListProps> = ({
  workspace,
  teams,
  canEdit,
}) => {
  const feed = useTouchedIssues(workspace.id, ME);
  const touched = useMemo(
    () => feed.activity.slice(0, ACTIVITY_LIMIT),
    [feed.activity]
  );
  const context = useMemberActivityContext(workspace.id, touched);
  const ids = useMemo(() => touched.map((row) => row.issue_id), [touched]);
  const idsJson = ids.join(',');
  const scope = useMemo<IssueListFilters>(
    () => ({
      issue_id: idsJson === '' ? [UNMATCHED_ISSUE_ID] : idsJson.split(','),
    }),
    [idsJson]
  );
  const rank = useMemo(
    () => new Map(ids.map((id, index) => [id, index])),
    [ids]
  );
  const base = useMemo(activityBase, []);
  const latest = useMemo(
    () => new Map(touched.map((row) => [row.issue_id, row])),
    [touched]
  );
  const rowNote = useCallback(
    (issue: OrderedIssueRead): React.ReactNode => {
      const row = latest.get(issue.id);
      if (row === undefined) return undefined;
      return (
        <>
          You {memberAction(row, context)}
          <span aria-hidden="true"> · </span>
          <RelativeTime value={row.created_at} />
        </>
      );
    },
    [latest, context]
  );

  const tabs = <MyIssuesTabs current="activity" />;
  if (touched.length === 0) {
    return (
      <WorkspaceShell title="My issues" toolbar={tabs} flush>
        {feed.error !== null && feed.error !== undefined ? (
          <div className="px-4 pt-3 lg:px-6">
            <ErrorAlert
              message={errorMessage(feed.error, 'Could not load the activity.')}
            />
          </div>
        ) : feed.isLoading || feed.isPaging ? (
          <SkeletonRows label="Loading activity" />
        ) : (
          <EmptyState message={ACTIVITY_EMPTY} />
        )}
      </WorkspaceShell>
    );
  }

  return (
    <IssueViewPage
      workspaceId={workspace.id}
      slug={workspace.slug}
      title="My issues"
      tabs={tabs}
      scopeKey="mine-activity"
      scope={scope}
      teams={teams}
      base={base}
      canEdit={canEdit}
      homeTeam={teams.length === 1 ? teams[0] : undefined}
      emptyMessage={ACTIVITY_EMPTY}
      rank={rank}
      saveScope={{ issue_id: ids }}
      rowNote={rowNote}
      holdRows
      footer={
        <ActivityPager
          feed={feed}
          capped={feed.activity.length >= ACTIVITY_LIMIT}
        />
      }
    />
  );
};

/** The cross-team list of the caller's own issues. */
export const MyIssues: React.FC = () => {
  const { workspace } = useWorkspace();
  const { teams, isLoading, error } = useTeam(undefined);
  const [params] = useSearchParams();
  const tab = readTab(params.get(TAB_PARAM));
  const base = useMemo(
    () => tabBase(tab === 'activity' ? 'assigned' : tab),
    [tab]
  );
  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';
  useTabShortcuts();

  const empty = tab === 'activity' ? ACTIVITY_EMPTY : TABS[tab].empty;

  if (workspace === null || teams.length === 0) {
    return (
      <WorkspaceShell title="My issues" flush>
        {error !== null && error !== undefined ? (
          <div className="px-4 pt-3 lg:px-6">
            <ErrorAlert
              message={errorMessage(error, 'Could not load your teams.')}
            />
          </div>
        ) : isLoading || workspace === null ? (
          <SkeletonRows label="Loading issues" />
        ) : (
          <EmptyState message={empty} />
        )}
      </WorkspaceShell>
    );
  }

  const canEdit = teams.some((team) =>
    canWriteIssues(workspace.role, team.role)
  );

  if (tab === 'activity') {
    return (
      <ActivityList
        key="activity"
        workspace={workspace}
        teams={teams}
        canEdit={canEdit}
      />
    );
  }

  const spec = TABS[tab];

  return (
    <IssueViewPage
      key={tab}
      workspaceId={workspaceId}
      slug={slug}
      title="My issues"
      tabs={<MyIssuesTabs current={tab} />}
      scopeKey={`mine-${tab}`}
      scope={spec.scope}
      teams={teams}
      base={base}
      canEdit={canEdit}
      homeTeam={teams.length === 1 ? teams[0] : undefined}
      emptyMessage={spec.empty}
      hideFilterFields={spec.hidden}
      focusGrouping={spec.focus === true}
    />
  );
};

export default MyIssues;
