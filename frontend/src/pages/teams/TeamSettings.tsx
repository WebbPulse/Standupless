/**
 * One team's settings: its name and key, who belongs to it, the statuses its
 * issues move through, its labels, and the rules that move an issue when a
 * pull request changes. These are a route of their own so a link to them
 * survives being sent to someone else.
 *
 * The sections sit on one scrolling page with a list of anchors beside them
 * rather than a page each, because they are short and a team admin setting up
 * a new team walks through them in order.
 */

import React from 'react';
import { useParams } from 'react-router-dom';
import LabelsSection from '../../components/team/LabelsSection';
import TeamGeneralSection from '../../components/team/TeamGeneralSection';
import TeamMembersSection from '../../components/team/TeamMembersSection';
import StatusesSection from '../../components/team/StatusesSection';
import TransitionsSection from '../../components/team/TransitionsSection';
import { ErrorAlert } from '../../components/ui/alert';
import EmptyState from '../../components/ui/empty-state';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import TeamTabs from '../../components/workspace/TeamTabs';
import TeamTitle from '../../components/workspace/TeamTitle';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import {
  canDeleteTeam,
  canManageMembers,
  isTeamAdmin,
} from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';

/** The sections in page order, as the anchor list names them. */
const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'members', label: 'Members' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'labels', label: 'Labels' },
  { id: 'github', label: 'GitHub' },
] as const;

/**
 * Scrolls a section into view inside the page's own scroll area, which a bare
 * hash link would do too but would also push a history entry per click.
 */
const jumpTo = (event: React.MouseEvent<HTMLAnchorElement>, id: string) => {
  const target = globalThis.document.getElementById(`team-settings-${id}`);
  if (target === null) return;
  event.preventDefault();
  if (typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  target.focus({ preventScroll: true });
};

/** The General, Members, Workflow, Labels and GitHub settings of one team. */
const TeamSettings: React.FC = () => {
  const { keyPrefix, slug } = useParams<{ keyPrefix: string; slug: string }>();
  const { workspace } = useWorkspace();
  const { team, workspaceId, isLoading, notFound, error } = useTeam(keyPrefix);

  if (isLoading) {
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

  if (notFound || team === null) {
    return (
      <WorkspaceShell title="Team not found">
        <EmptyState message="No team in this workspace uses that key, or you do not have access to it." />
      </WorkspaceShell>
    );
  }

  const editable = isTeamAdmin(workspace?.role, team.role);

  const frame = (
    id: (typeof SECTIONS)[number]['id'],
    node: React.ReactNode
  ) => (
    <div
      id={`team-settings-${id}`}
      tabIndex={-1}
      className="scroll-mt-4 border-t border-line pt-6 first:border-t-0 first:pt-0 focus:outline-none"
    >
      {node}
    </div>
  );

  return (
    <WorkspaceShell
      title={<TeamTitle name={team.name} keyPrefix={team.key_prefix} />}
      toolbar={
        <TeamTabs
          slug={slug ?? ''}
          keyPrefix={team.key_prefix}
          current="settings"
        />
      }
    >
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load this team.')}
        />
      )}
      <div className="flex gap-10">
        <nav
          aria-label="Team settings sections"
          className="sticky top-0 hidden w-40 shrink-0 self-start lg:block"
        >
          <p className="px-2 pb-1 text-2xs font-medium text-text-faint">
            {team.name}
          </p>
          <ul className="space-y-px">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#team-settings-${section.id}`}
                  onClick={(event) => {
                    jumpTo(event, section.id);
                  }}
                  className="flex h-7 items-center rounded-sm px-2 text-sm text-text-muted transition-colors duration-100 hover:bg-raised/70 hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
                >
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 max-w-2xl flex-1 space-y-6">
          {frame(
            'general',
            <TeamGeneralSection
              workspaceId={workspaceId}
              slug={slug ?? ''}
              team={team}
              canEdit={editable}
              canDelete={canDeleteTeam(workspace?.role)}
            />
          )}
          {frame(
            'members',
            <TeamMembersSection
              workspaceId={workspaceId}
              teamId={team.id}
              canEdit={editable}
              canReadWorkspaceMembers={canManageMembers(workspace?.role)}
            />
          )}
          {frame(
            'workflow',
            <StatusesSection
              workspaceId={workspaceId}
              teamId={team.id}
              canEdit={editable}
            />
          )}
          {frame(
            'labels',
            <LabelsSection
              workspaceId={workspaceId}
              teamId={team.id}
              canEdit={editable}
            />
          )}
          {frame(
            'github',
            <TransitionsSection
              workspaceId={workspaceId}
              teamId={team.id}
              canEdit={editable}
            />
          )}
        </div>
      </div>
    </WorkspaceShell>
  );
};

export default TeamSettings;
