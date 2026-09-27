/**
 * The signed in person's own issues across the workspace, drawn as the same
 * grouped list or board as a team's issues, under three tabs like Linear's:
 * Assigned (`assignee_id=me`), Created (`creator_id=me`) and Subscribed
 * (`subscriber_id=me`). Each is resolved server side from a keyed index and
 * spans every team the caller belongs to, so rows name their team and
 * statuses group by name. The tab lives in the URL, so a link lands on it.
 */

import React, { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ME, type IssueListFilters } from '../../api/issues';
import IssueViewPage from '../../components/issues/view/IssueViewPage';
import { ErrorAlert } from '../../components/ui/alert';
import EmptyState from '../../components/ui/empty-state';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { defaultViewState, type FilterField } from '../../lib/issueView';

/** Which of the caller's relationships to an issue the page lists. */
export type MyIssuesTab = 'assigned' | 'created' | 'subscribed';

/** The URL parameter holding the tab; absent means Assigned. */
export const TAB_PARAM = 'tab';

/** What each tab reads, labels and says when empty. */
interface TabSpec {
  label: string;
  scope: IssueListFilters;
  hidden: FilterField[];
  empty: string;
}

/** The tabs in the order they show. The assignee filter is hidden where the tab fixes it. */
const TABS: Record<MyIssuesTab, TabSpec> = {
  assigned: {
    label: 'Assigned',
    scope: { assignee_id: ME },
    hidden: ['assignee'],
    empty: 'Nothing is assigned to you right now.',
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

const TAB_ORDER: MyIssuesTab[] = ['assigned', 'created', 'subscribed'];

/** Reads the tab from the URL, falling back to Assigned for anything unknown. */
const readTab = (value: string | null): MyIssuesTab =>
  value !== null && (TAB_ORDER as string[]).includes(value)
    ? (value as MyIssuesTab)
    : 'assigned';

const tabClass = (active: boolean): string =>
  cn(
    'flex h-7 items-center rounded-sm px-2.5 text-sm font-medium transition-colors duration-100',
    'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
    active ? 'bg-raised text-text' : 'text-text-muted hover:text-text'
  );

/**
 * The Assigned, Created and Subscribed switch. Links rather than buttons, so
 * each tab is an address; switching starts the new tab from its own defaults.
 */
const MyIssuesTabs: React.FC<{ current: MyIssuesTab }> = ({ current }) => (
  <nav aria-label="My issues" className="flex items-center gap-1">
    {TAB_ORDER.map((tab) => (
      <Link
        key={tab}
        to={{ search: tab === 'assigned' ? '' : `?${TAB_PARAM}=${tab}` }}
        className={tabClass(current === tab)}
        {...(current === tab ? { 'aria-current': 'page' as const } : {})}
      >
        {TABS[tab].label}
      </Link>
    ))}
  </nav>
);

/** The cross-team list of the caller's own issues. */
export const MyIssues: React.FC = () => {
  const { workspace } = useWorkspace();
  const { teams, isLoading, error } = useTeam(undefined);
  const [params] = useSearchParams();
  const tab = readTab(params.get(TAB_PARAM));
  const spec = TABS[tab];
  const base = useMemo(() => defaultViewState('list'), []);
  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';

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
    />
  );
};

export default MyIssues;
