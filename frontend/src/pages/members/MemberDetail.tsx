/**
 * One workspace member's page, after Linear's: a header with their avatar,
 * name and teams over four tabs. Assigned, Created and Subscribed are the same
 * grouped list as My issues, scoped to this member, so the display menu,
 * filters and keyboard work the same; Activity is their recent issue changes
 * and comments. The server answers only with issues the viewer can read, and
 * someone outside the workspace reads as not found. No email is shown.
 */

import React, { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { type IssueListFilters } from '../../api/issues';
import IssueViewPage from '../../components/issues/view/IssueViewPage';
import MemberActivityFeed from '../../components/members/MemberActivityFeed';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import EmptyState from '../../components/ui/empty-state';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import {
  useMemberActivity,
  useMemberProfile,
} from '../../hooks/useMemberActivity';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { errorMessage, hasStatus } from '../../lib/errors';
import { defaultViewState, type FilterField } from '../../lib/issueView';
import { memberPath, teamPath } from '../../lib/paths';
import type { MemberProfileRead, TeamRead } from '../../types/Api';

/** The tabs a member page offers. */
export type MemberTab = 'assigned' | 'created' | 'subscribed' | 'activity';

/** The issue list tabs, which share My issues' list. */
type IssueTab = Exclude<MemberTab, 'activity'>;

/** The URL parameter holding the tab; absent means Assigned. */
export const MEMBER_TAB_PARAM = 'tab';

/** What each issue tab reads, labels and says when empty. */
interface TabSpec {
  label: string;
  scope: (userId: string) => IssueListFilters;
  hidden: FilterField[];
  empty: string;
}

const ISSUE_TABS: Record<IssueTab, TabSpec> = {
  assigned: {
    label: 'Assigned',
    scope: (userId) => ({ assignee_id: userId }),
    hidden: ['assignee'],
    empty: 'Nothing you can see is assigned to this member.',
  },
  created: {
    label: 'Created',
    scope: (userId) => ({ creator_id: userId }),
    hidden: [],
    empty: 'This member has not created any issues you can see.',
  },
  subscribed: {
    label: 'Subscribed',
    scope: (userId) => ({ subscriber_id: userId }),
    hidden: [],
    empty: 'This member is not subscribed to any issues you can see.',
  },
};

const TAB_ORDER: MemberTab[] = [
  'assigned',
  'created',
  'subscribed',
  'activity',
];

const TAB_LABELS: Record<MemberTab, string> = {
  assigned: 'Assigned',
  created: 'Created',
  subscribed: 'Subscribed',
  activity: 'Activity',
};

/** Reads the tab from the URL, falling back to Assigned for anything unknown. */
const readMemberTab = (value: string | null): MemberTab =>
  value !== null && (TAB_ORDER as string[]).includes(value)
    ? (value as MemberTab)
    : 'assigned';

const tabClass = (active: boolean): string =>
  cn(
    'flex h-7 items-center rounded-sm px-2.5 text-sm font-medium whitespace-nowrap transition-colors duration-100 pointer-coarse:h-10',
    'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
    active ? 'bg-raised text-text' : 'text-text-muted hover:text-text'
  );

/** The tab switch, as links so each tab is an address. */
const MemberTabs: React.FC<{
  current: MemberTab;
  slug: string;
  userId: string;
}> = ({ current, slug, userId }) => (
  <nav aria-label="Member" className="flex items-center gap-1">
    {TAB_ORDER.map((tab) => (
      <Link
        key={tab}
        to={memberPath(slug, userId, tab)}
        className={tabClass(current === tab)}
        {...(current === tab ? { 'aria-current': 'page' as const } : {})}
      >
        {TAB_LABELS[tab]}
      </Link>
    ))}
  </nav>
);

/** The member's name as the page heads with it. */
const memberName = (profile: MemberProfileRead): string =>
  profile.display_name !== ''
    ? profile.display_name
    : profile.full_name !== undefined && profile.full_name !== ''
      ? profile.full_name
      : 'Member';

/** The avatar before the title. */
const MemberAvatar: React.FC<{ profile: MemberProfileRead }> = ({
  profile,
}) => (
  <Avatar
    name={memberName(profile)}
    src={profile.avatar_url ?? null}
    size="sm"
  />
);

/** The member's teams after the title, each linking to the team. */
const MemberTeams: React.FC<{
  profile: MemberProfileRead;
  teams: TeamRead[];
  slug: string;
}> = ({ profile, teams, slug }) => {
  const ids = new Set(profile.team_ids ?? []);
  const shown = teams.filter((team) => ids.has(team.id));
  if (shown.length === 0) return null;
  return (
    <ul aria-label="Teams" className="ml-2 flex min-w-0 items-center gap-1">
      {shown.map((team) => (
        <li key={team.id}>
          <Link
            to={teamPath(slug, team.key_prefix)}
            className="inline-flex h-5 items-center rounded-full border border-line px-1.5 text-2xs text-text-muted hover:bg-raised hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            {team.name}
          </Link>
        </li>
      ))}
    </ul>
  );
};

/** The member page: header, tabs and the tab's body. */
export const MemberDetail: React.FC = () => {
  const { userId = '' } = useParams<{ userId: string }>();
  const { workspace } = useWorkspace();
  const {
    teams,
    isLoading: teamsLoading,
    error: teamsError,
  } = useTeam(undefined);
  const [params] = useSearchParams();
  const tab = readMemberTab(params.get(MEMBER_TAB_PARAM));
  const base = useMemo(() => defaultViewState('list'), []);
  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';
  const { profile, error } = useMemberProfile(workspaceId, userId);
  const feed = useMemberActivity(
    workspaceId,
    userId,
    tab === 'activity' && profile !== null
  );

  if (profile === null) {
    return (
      <WorkspaceShell title="Member" flush>
        {hasStatus(error, 404) ? (
          <EmptyState message="This person is not a member of this workspace." />
        ) : error !== null && error !== undefined ? (
          <div className="px-4 pt-3 lg:px-6">
            <ErrorAlert
              message={errorMessage(error, 'Could not load this member.')}
            />
          </div>
        ) : (
          <SkeletonRows label="Loading member" />
        )}
      </WorkspaceShell>
    );
  }

  const name = memberName(profile);
  const tabs = <MemberTabs current={tab} slug={slug} userId={userId} />;
  const leading = <MemberAvatar profile={profile} />;
  const accessory = <MemberTeams profile={profile} teams={teams} slug={slug} />;

  if (tab === 'activity') {
    return (
      <WorkspaceShell
        title={name}
        leading={leading}
        titleAccessory={accessory}
        toolbar={tabs}
      >
        <MemberActivityFeed
          feed={feed}
          workspaceId={workspaceId}
          slug={slug}
          name={name}
          avatarUrl={profile.avatar_url ?? null}
          emptyMessage="No recent activity you can see."
        />
      </WorkspaceShell>
    );
  }

  const spec = ISSUE_TABS[tab];

  if (workspace === null || teams.length === 0) {
    return (
      <WorkspaceShell
        title={name}
        leading={leading}
        titleAccessory={accessory}
        toolbar={tabs}
        flush
      >
        {teamsError !== null && teamsError !== undefined ? (
          <div className="px-4 pt-3 lg:px-6">
            <ErrorAlert
              message={errorMessage(teamsError, 'Could not load your teams.')}
            />
          </div>
        ) : teamsLoading || workspace === null ? (
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
      key={`${userId}-${tab}`}
      workspaceId={workspaceId}
      slug={slug}
      title={name}
      leading={leading}
      titleAccessory={accessory}
      tabs={tabs}
      scopeKey={`member-${userId}-${tab}`}
      scope={spec.scope(userId)}
      teams={teams}
      base={base}
      canEdit={canEdit}
      homeTeam={teams.length === 1 ? teams[0] : undefined}
      emptyMessage={spec.empty}
      hideFilterFields={spec.hidden}
    />
  );
};

export default MemberDetail;
