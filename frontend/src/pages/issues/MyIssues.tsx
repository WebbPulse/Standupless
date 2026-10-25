/**
 * The signed in person's own issues across the workspace, under four tabs
 * like Linear's. Assigned (`assignee_id=me`), Created (`creator_id=me`) and
 * Subscribed (`subscriber_id=me`) draw the same grouped list or board as a
 * team's issues, resolved server side from a keyed index across every team
 * the caller belongs to. Activity lists the issues the caller last changed or
 * commented on, one row per issue led by its latest action, from the same
 * member activity read the member page uses. The tab lives in the URL, so a
 * link lands on it, and the number keys switch tabs while the page is open.
 * Assigned opens grouped by Focus, as Linear's does, and is the only list
 * that offers that grouping.
 */

import React, { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ME, type IssueListFilters } from '../../api/issues';
import IssueViewPage from '../../components/issues/view/IssueViewPage';
import MemberActivityFeed from '../../components/members/MemberActivityFeed';
import { ErrorAlert } from '../../components/ui/alert';
import EmptyState from '../../components/ui/empty-state';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useAuth } from '../../hooks/useAuth';
import {
  useMemberActivity,
  type MemberActivity,
} from '../../hooks/useMemberActivity';
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
import type { MemberActivityRead } from '../../types/Api';

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

/**
 * Keeps the newest row for each issue, so the Activity tab lists each issue
 * once, ordered by the caller's latest action on it.
 */
export const latestPerIssue = (
  rows: MemberActivityRead[]
): MemberActivityRead[] => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.issue_id)) return false;
    seen.add(row.issue_id);
    return true;
  });
};

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

/** The caller's activity feed, folded to one row per issue. */
const useMyActivity = (
  workspaceId: string,
  enabled: boolean
): MemberActivity => {
  const feed = useMemberActivity(workspaceId, ME, enabled);
  const activity = useMemo(
    () => latestPerIssue(feed.activity),
    [feed.activity]
  );
  return { ...feed, activity };
};

/** The cross-team list of the caller's own issues. */
export const MyIssues: React.FC = () => {
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const { teams, isLoading, error } = useTeam(undefined);
  const [params] = useSearchParams();
  const tab = readTab(params.get(TAB_PARAM));
  const base = useMemo(
    () => tabBase(tab === 'activity' ? 'assigned' : tab),
    [tab]
  );
  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';
  const feed = useMyActivity(workspaceId, tab === 'activity');
  useTabShortcuts();

  if (tab === 'activity') {
    return (
      <WorkspaceShell
        title="My issues"
        toolbar={<MyIssuesTabs current={tab} />}
      >
        {workspace === null ? (
          <SkeletonRows label="Loading activity" />
        ) : (
          <MemberActivityFeed
            feed={feed}
            workspaceId={workspaceId}
            slug={slug}
            name="You"
            avatarUrl={user?.avatar_url ?? null}
            emptyMessage={ACTIVITY_EMPTY}
          />
        )}
      </WorkspaceShell>
    );
  }

  const spec = TABS[tab];

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
          <EmptyState message={spec.empty} />
        )}
      </WorkspaceShell>
    );
  }

  const canEdit = teams.some((team) =>
    canWriteIssues(workspace.role, team.role)
  );

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
