/**
 * One team's settings: its name and key, the parent team it sits under, who belongs to it, the statuses its
 * issues move through, its labels, the project labels and statuses its projects are offered beside the workspace's, its issue templates and the recurring issues made from them, its automatic cycles, the addresses mail files issues through, when stale open
 * issues close, how long closed issues stay before they are archived, its SLA
 * rules, the rules that move an issue when a pull request changes, whether
 * linked pull requests carry its issue labels, the GitHub repository its issues sync with, the release
 * pipeline its releases move through, the caller's own notifications for its
 * issues, the Slack and Discord channels it posts notifications to, its outbound webhooks, and a danger zone for
 * retiring or deleting it. These are a route of
 * their own so a link to them survives being sent to someone else.
 *
 * The sections sit on one scrolling page with a list of anchors beside them,
 * under the settings sidebar's search, rather than a page each, because they are short and a team admin setting up
 * a new team walks through them in order.
 */

import React, { useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import AutoArchiveSection from '../../components/team/AutoArchiveSection';
import AutoCloseSection from '../../components/team/AutoCloseSection';
import ParentAutoCloseSection from '../../components/team/ParentAutoCloseSection';
import CyclesSection from '../../components/team/CyclesSection';
import EmailIntakeSection from '../../components/team/EmailIntakeSection';
import IssueSyncSection from '../../components/team/IssueSyncSection';
import LabelsSection from '../../components/team/LabelsSection';
import ProjectsSection from '../../components/team/ProjectsSection';
import PullRequestLabelsSection from '../../components/team/PullRequestLabelsSection';
import RecurringSection from '../../components/team/RecurringSection';
import ReleasePipelineSection from '../../components/team/ReleasePipelineSection';
import SlaSection from '../../components/team/SlaSection';
import { TeamNotificationsPanel } from '../../components/team/TeamNotifications';
import StandupSection from '../../components/team/StandupSection';
import TeamGeneralSection from '../../components/team/TeamGeneralSection';
import TeamMembersSection from '../../components/team/TeamMembersSection';
import TeamParentSection from '../../components/team/TeamParentSection';
import TeamChannelsSection from '../../components/team/TeamChannelsSection';
import SlackReactionIntakeSection from '../../components/team/SlackReactionIntakeSection';
import TeamDangerZoneSection from '../../components/team/TeamDangerZoneSection';
import RetiredTeamBanner from '../../components/team/RetiredTeamBanner';
import DiscordReturnToast from '../../components/team/DiscordReturnToast';
import SlackReturnToast from '../../components/team/SlackReturnToast';
import TeamPrivacySection from '../../components/team/TeamPrivacySection';
import TeamWebhooksSection from '../../components/team/TeamWebhooksSection';
import TemplatesSection from '../../components/team/TemplatesSection';
import StatusesSection from '../../components/team/StatusesSection';
import TransitionsSection from '../../components/team/TransitionsSection';
import TriageSection from '../../components/team/TriageSection';
import { ErrorAlert } from '../../components/ui/alert';
import EmptyState from '../../components/ui/empty-state';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import TeamTabs from '../../components/workspace/TeamTabs';
import TeamTitle from '../../components/workspace/TeamTitle';
import { useTeam } from '../../hooks/useTeam';
import { useTeamsFor } from '../../hooks/useTeams';
import { useOffline } from '../../hooks/useOffline';
import { useWorkspace } from '../../hooks/useWorkspace';
import { planIncludes } from '../../lib/billing';
import {
  canDeleteTeam,
  canManageMembers,
  canWriteIssues,
  isTeamAdmin,
} from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { isFeatureOn } from '../../lib/features';
import { teamSettingsPath } from '../../lib/paths';
import { estimateOptionsOf } from '../../lib/validation';

/** The sections in page order, as the anchor list names them. */
const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'members', label: 'Members' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'labels', label: 'Labels' },
  { id: 'projects', label: 'Projects' },
  { id: 'templates', label: 'Templates' },
  { id: 'recurring', label: 'Recurring' },
  { id: 'cycles', label: 'Cycles' },
  { id: 'triage', label: 'Triage' },
  { id: 'email', label: 'Create by email' },
  { id: 'sla', label: 'SLAs' },
  { id: 'auto-close', label: 'Auto-close' },
  { id: 'parent-auto-close', label: 'Parent and sub-issues' },
  { id: 'archive', label: 'Auto-archive' },
  { id: 'standup', label: 'Standup' },
  { id: 'github', label: 'GitHub' },
  { id: 'releases', label: 'Releases' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'danger', label: 'Danger zone' },
] as const;

/** A template "Make recurring" opened the schedule form with, keyed per click. */
interface RecurringStart {
  templateId: string;
  nonce: number;
}

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

/** The General, Members, Workflow, Labels, GitHub and Webhooks settings of one team. */
const TeamSettings: React.FC = () => {
  const { keyPrefix, slug } = useParams<{ keyPrefix: string; slug: string }>();
  const { workspace } = useWorkspace();
  const offline = useOffline();
  const { team, workspaceId, isLoading, notFound, error } = useTeam(keyPrefix);
  const { data: teams } = useTeamsFor(workspaceId);
  const { hash } = useLocation();
  const loaded = team !== null;
  const [recurringStart, setRecurringStart] = useState<RecurringStart | null>(
    null
  );

  useEffect(() => {
    if (!loaded || !hash.startsWith('#team-settings-')) return;
    const target = globalThis.document.getElementById(hash.slice(1));
    if (target !== null && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start' });
    }
  }, [loaded, hash]);

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

  const admin = isTeamAdmin(workspace?.role, team.role);
  const editable = admin && !offline;
  const writable = canWriteIssues(workspace?.role, team.role) && !offline;
  const parent = (teams ?? []).find((row) => row.id === team.parent_team_id);
  const parentSettings =
    parent === undefined
      ? undefined
      : teamSettingsPath(slug ?? '', parent.key_prefix);
  const mayDelete = canDeleteTeam(workspace?.role);
  const canDelete = mayDelete && !offline;
  const showDanger = mayDelete || admin;
  const releasesOn = isFeatureOn(workspace, 'releases');
  const sections = SECTIONS.filter(
    (section) =>
      (section.id !== 'danger' || showDanger) &&
      (section.id !== 'releases' || releasesOn)
  );

  const makeRecurring = (templateId: string): void => {
    setRecurringStart({ templateId, nonce: Date.now() });
    const target = globalThis.document.getElementById(
      'team-settings-recurring'
    );
    if (target !== null && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  };

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
          teamId={team.id}
          current="settings"
        />
      }
    >
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load this team.')}
        />
      )}
      {workspace !== null && (
        <RetiredTeamBanner
          workspaceId={workspace.id}
          team={team}
          canUnretire={editable}
        />
      )}
      <div className="flex flex-col gap-4 lg:flex-row lg:gap-10">
        <div className="hidden w-40 shrink-0 self-start lg:sticky lg:top-0 lg:block">
          <nav aria-label="Team settings sections">
            <p className="px-2 pb-1 text-2xs font-medium text-text-faint">
              {team.name}
            </p>
            <ul className="space-y-px">
              {sections.map((section) => (
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
        </div>

        <div className="min-w-0 max-w-2xl flex-1 space-y-6">
          {frame(
            'general',
            <div className="space-y-6">
              <TeamGeneralSection
                workspaceId={workspaceId}
                team={team}
                canEdit={editable}
                parentSettingsPath={parentSettings}
              />
              <TeamParentSection
                workspaceId={workspaceId}
                slug={slug ?? ''}
                team={team}
                canEdit={editable}
              />
              <TeamPrivacySection
                workspaceId={workspaceId}
                team={team}
                canEdit={editable}
              />
            </div>
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
              slug={slug ?? ''}
              parentSettingsPath={parentSettings}
              canEdit={editable}
            />
          )}
          {frame(
            'labels',
            <LabelsSection
              workspaceId={workspaceId}
              teamId={team.id}
              slug={slug ?? ''}
              parentSettingsPath={parentSettings}
              canEdit={editable}
            />
          )}
          {frame(
            'projects',
            <ProjectsSection
              workspaceId={workspaceId}
              teamId={team.id}
              canEdit={editable}
            />
          )}
          {frame(
            'templates',
            <TemplatesSection
              workspaceId={workspaceId}
              teamId={team.id}
              estimateScale={team.estimate_scale}
              estimateOptions={estimateOptionsOf(team)}
              canEdit={writable}
              canSetDefault={editable}
              onMakeRecurring={(template) => {
                makeRecurring(template.id);
              }}
            />
          )}
          {frame(
            'recurring',
            <RecurringSection
              key={recurringStart?.nonce ?? 0}
              workspaceId={workspaceId}
              teamId={team.id}
              canEdit={writable}
              initialTemplateId={recurringStart?.templateId ?? null}
            />
          )}
          {frame(
            'cycles',
            <CyclesSection
              workspaceId={workspaceId}
              teamId={team.id}
              canEdit={editable}
              parentSettingsPath={parentSettings}
              inherited={
                team.parent_team_id !== undefined &&
                team.parent_team_id !== null
              }
            />
          )}
          {frame(
            'triage',
            <TriageSection
              workspaceId={workspaceId}
              teamId={team.id}
              canEdit={editable}
              planIncluded={planIncludes(workspace?.plan, 'triage')}
              slug={slug ?? ''}
            />
          )}
          {frame(
            'email',
            <EmailIntakeSection
              workspaceId={workspaceId}
              teamId={team.id}
              canEdit={editable}
            />
          )}
          {frame(
            'sla',
            <SlaSection
              workspaceId={workspaceId}
              teamId={team.id}
              canEdit={editable}
              planIncluded={planIncludes(workspace?.plan, 'issue_slas')}
              slug={slug ?? ''}
            />
          )}
          {frame(
            'auto-close',
            <AutoCloseSection
              workspaceId={workspaceId}
              teamId={team.id}
              canEdit={editable}
            />
          )}
          {frame(
            'parent-auto-close',
            <ParentAutoCloseSection
              workspaceId={workspaceId}
              teamId={team.id}
              canEdit={editable}
            />
          )}
          {frame(
            'archive',
            <AutoArchiveSection
              workspaceId={workspaceId}
              teamId={team.id}
              canEdit={editable}
            />
          )}
          {frame(
            'standup',
            <StandupSection
              workspaceId={workspaceId}
              teamId={team.id}
              canEdit={editable}
            />
          )}
          {frame(
            'github',
            <div className="space-y-8">
              <TransitionsSection
                workspaceId={workspaceId}
                teamId={team.id}
                canEdit={editable}
              />
              <PullRequestLabelsSection
                workspaceId={workspaceId}
                team={team}
                canEdit={editable}
              />
              <IssueSyncSection
                workspaceId={workspaceId}
                teamId={team.id}
                canEdit={editable}
                canPickRepository={canManageMembers(workspace?.role)}
              />
            </div>
          )}
          {releasesOn &&
            frame(
              'releases',
              <ReleasePipelineSection
                workspaceId={workspaceId}
                teamId={team.id}
                canEdit={editable}
              />
            )}
          {frame(
            'notifications',
            <div className="space-y-6">
              <section className="space-y-3">
                <h3 className="text-base font-semibold">Your notifications</h3>
                <TeamNotificationsPanel
                  workspaceId={workspaceId}
                  teamId={team.id}
                />
              </section>
              <TeamChannelsSection
                workspaceId={workspaceId}
                teamId={team.id}
                canEdit={editable}
                canManageWorkspace={canManageMembers(workspace?.role)}
                {...(workspace === null
                  ? {}
                  : { workspaceSlug: workspace.slug })}
              />
              <SlackReactionIntakeSection
                workspaceId={workspaceId}
                teamId={team.id}
                canEdit={editable}
                {...(workspace === null
                  ? {}
                  : { workspaceSlug: workspace.slug })}
              />
              <SlackReturnToast />
              <DiscordReturnToast />
            </div>
          )}
          {frame(
            'webhooks',
            <TeamWebhooksSection
              workspaceId={workspaceId}
              teamId={team.id}
              canEdit={editable}
            />
          )}
          {showDanger &&
            frame(
              'danger',
              <TeamDangerZoneSection
                workspaceId={workspaceId}
                slug={slug ?? ''}
                team={team}
                canRetire={editable}
                canDelete={canDelete}
              />
            )}
        </div>
      </div>
    </WorkspaceShell>
  );
};

export default TeamSettings;
