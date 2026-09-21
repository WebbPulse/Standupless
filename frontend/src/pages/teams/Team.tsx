/**
 * One team, resolved from the `:keyPrefix` in the route. Holds the issues
 * tab, which carries the filtered list and the create form, and the settings
 * tab carrying statuses, labels, team members and the pull request
 * transition rules. The board, cycles and projects are reached from the
 * sidebar, which names them for the current team.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { useParams } from 'react-router-dom';
import { listTeams } from '../../api/teams';
import TeamIssues from '../../components/issues/TeamIssues';
import LabelsSection from '../../components/team/LabelsSection';
import TeamMembersSection from '../../components/team/TeamMembersSection';
import StatusesSection from '../../components/team/StatusesSection';
import TransitionsSection from '../../components/team/TransitionsSection';
import { ErrorAlert } from '../../components/ui/alert';
import EmptyState from '../../components/ui/empty-state';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import {
  canManageMembers,
  canWriteIssues,
  isTeamAdmin,
} from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { teamsKey } from '../../lib/queryKeys';

/** How often the team list is re-read while this page is open. */
const POLL_MS = 60000;

/** Which tab of the team page is showing. */
type Tab = 'issues' | 'settings';

/** The classes one tab button carries, lit when it is the showing one. */
const tabClass = (active: boolean): string =>
  cn(
    'h-7 rounded-sm px-2.5 text-sm font-medium transition-colors duration-100',
    active ? 'bg-raised text-text' : 'text-text-muted hover:text-text'
  );

/** Props for TabSwitch: the showing tab and how to change it. */
interface TabSwitchProps {
  tab: Tab;
  onChange: (tab: Tab) => void;
}

/** The Issues and Settings switch at the start of the toolbar. */
const TabSwitch: React.FC<TabSwitchProps> = ({ tab, onChange }) => (
  <div className="flex items-center gap-1">
    <button
      type="button"
      aria-pressed={tab === 'issues'}
      className={tabClass(tab === 'issues')}
      onClick={() => {
        onChange('issues');
      }}
    >
      Issues
    </button>
    <button
      type="button"
      aria-pressed={tab === 'settings'}
      className={tabClass(tab === 'settings')}
      onClick={() => {
        onChange('settings');
      }}
    >
      Settings
    </button>
  </div>
);

/** Props for TeamTitle: the name and the key prefix beside it. */
interface TeamTitleProps {
  name: string;
  keyPrefix: string;
}

/** The team name with its mono key prefix, for the shell's title. */
const TeamTitle: React.FC<TeamTitleProps> = ({ name, keyPrefix }) => (
  <span className="flex items-baseline gap-2">
    <span>{name}</span>
    <span className="font-mono text-xs font-normal text-text-faint">
      {keyPrefix}
    </span>
  </span>
);

/**
 * Resolves the key prefix to a team through the workspace's team list,
 * which the contract makes the only route that can answer it, then renders the
 * tab that is showing.
 */
const Team: React.FC = () => {
  const { keyPrefix, slug } = useParams<{ keyPrefix: string; slug: string }>();
  const { workspace } = useWorkspace();
  const auth = useQueryAuth();
  const [tab, setTab] = useState<Tab>('issues');

  const workspaceId = workspace?.id ?? '';

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listTeams(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: teamsKey(workspaceId),
      auth,
    }
  );

  const team =
    data === null || keyPrefix === undefined
      ? null
      : (data.find((item) => item.key_prefix === keyPrefix) ?? null);

  const editable = isTeamAdmin(workspace?.role, team?.role);

  if (isLoading || data === null) {
    return (
      <WorkspaceShell>
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load this team.')}
          />
        )}
        <Spinner label="Loading team" />
      </WorkspaceShell>
    );
  }

  if (team === null) {
    return (
      <WorkspaceShell title="Team not found">
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load this team.')}
          />
        )}
        <EmptyState message="No team in this workspace uses that key, or you do not have access to it." />
      </WorkspaceShell>
    );
  }

  const title = <TeamTitle name={team.name} keyPrefix={team.key_prefix} />;
  const tabs = <TabSwitch tab={tab} onChange={setTab} />;

  if (tab === 'issues') {
    return (
      <TeamIssues
        workspaceId={workspaceId}
        teamId={team.id}
        slug={slug ?? ''}
        estimateScale={team.estimate_scale}
        canCreate={canWriteIssues(workspace?.role, team.role)}
        title={title}
        tabs={tabs}
      />
    );
  }

  return (
    <WorkspaceShell title={title} toolbar={tabs}>
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load this team.')}
        />
      )}
      <div className="max-w-2xl space-y-6">
        <StatusesSection
          workspaceId={workspaceId}
          teamId={team.id}
          canEdit={editable}
        />
        <LabelsSection
          workspaceId={workspaceId}
          teamId={team.id}
          canEdit={editable}
        />
        <TeamMembersSection
          workspaceId={workspaceId}
          teamId={team.id}
          canEdit={editable}
          canReadWorkspaceMembers={canManageMembers(workspace?.role)}
        />
        <TransitionsSection
          workspaceId={workspaceId}
          teamId={team.id}
          canEdit={editable}
        />
      </div>
    </WorkspaceShell>
  );
};

export default Team;
