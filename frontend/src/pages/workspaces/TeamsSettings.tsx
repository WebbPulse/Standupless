/**
 * The Teams page of workspace settings: every team the caller can see, with
 * its key and the caller's role on it, a way into each team's own settings,
 * and a button to create one.
 *
 * Any member reaches this page, because the team list route answers for any
 * member. Creating is offered to the roles the create route allows. There is
 * no join or leave here: adding or removing a team member needs a team admin,
 * and a workspace owner, admin or member already holds an implied role on
 * every team, so there is nothing for a person to join or leave on their own.
 *
 * Retired teams leave the main table for a list of their own below it, where a
 * team admin can un-retire one.
 */

import React, { useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { LuEllipsis, LuLock, LuPlus, LuUsersRound } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import Avatar from '../../components/ui/avatar';
import Button, { IconButton } from '../../components/ui/button';
import { ErrorAlert } from '../../components/ui/alert';
import EmptyState from '../../components/ui/empty-state';
import Menu, { MenuItem } from '../../components/ui/menu';
import RelativeTime from '../../components/ui/relative-time';
import { SkeletonRows } from '../../components/ui/skeleton';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useCreateTeam } from '../../hooks/useCreateTeam';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { unretireTeam } from '../../api/teams';
import { isTeamAdmin, roleLabel } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { teamPath, teamSettingsPath } from '../../lib/paths';
import { teamsKey } from '../../lib/queryKeys';
import { activeTeams, retiredTeams } from '../../lib/teamRetirement';
import type { TeamRead, WorkspaceRead } from '../../types/Api';

/** Copies an in-application path as a full link, ignoring a refused clipboard. */
const copyLink = (path: string): void => {
  void globalThis.navigator.clipboard
    .writeText(`${globalThis.location.origin}${path}`)
    .catch(() => undefined);
};

/** Props for RetiredTeams. */
interface RetiredTeamsProps {
  workspace: WorkspaceRead;
  teams: TeamRead[];
}

/** The retired teams, each with when it was retired and an un-retire action for its admins. */
const RetiredTeams: React.FC<RetiredTeamsProps> = ({ workspace, teams }) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const restore = async (team: TeamRead): Promise<void> => {
    setBusy(team.id);
    setError(null);
    try {
      await unretireTeam(workspace.id, team.id);
      invalidateQueries(teamsKey(workspace.id));
    } catch (caught) {
      setError(errorMessage(caught, `Could not un-retire ${team.name}.`));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="retired-teams-heading" className="space-y-2 pt-4">
      <div className="space-y-1">
        <h2 id="retired-teams-heading" className="text-base font-semibold">
          Retired teams
        </h2>
        <p className="text-sm text-text-muted">
          A retired team keeps its issues, projects and cycles readable, but
          nothing in it can change until it is un-retired.
        </p>
      </div>
      {error !== null && <ErrorAlert message={error} />}
      <ul className="divide-y divide-line rounded-md border border-line">
        {teams.map((team) => (
          <li
            key={team.id}
            className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
          >
            <Link
              to={teamSettingsPath(workspace.slug, team.key_prefix)}
              className="flex min-w-0 items-center gap-2 text-text-muted hover:underline"
            >
              <span className="truncate font-medium">{team.name}</span>
              <span className="font-mono text-xs">{team.key_prefix}</span>
            </Link>
            <div className="flex shrink-0 items-center gap-3">
              {team.retired_at !== undefined && team.retired_at !== null && (
                <span className="text-xs text-text-faint">
                  Retired <RelativeTime value={team.retired_at} />
                </span>
              )}
              {isTeamAdmin(workspace.role, team.role) && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => {
                    void restore(team);
                  }}
                >
                  {busy === team.id ? 'Un-retiring' : `Un-retire ${team.name}`}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
};

/** The list of teams with their keys, the caller's role and row actions. */
const TeamsSettings: React.FC = () => {
  const { workspace } = useWorkspace();
  const { teams: allTeams, isLoading, error } = useTeam(undefined);
  const teams = activeTeams(allTeams);
  const retired = retiredTeams(allTeams);
  const createTeam = useCreateTeam();
  const slug = workspace?.slug ?? '';

  const create = createTeam.canCreate ? (
    <Button type="button" variant="primary" size="sm" onClick={createTeam.open}>
      <LuPlus aria-hidden="true" className="h-3.5 w-3.5" />
      Create team
    </Button>
  ) : undefined;
  const limited = workspace?.role === 'member' && !createTeam.canCreate;

  return (
    <WorkspaceShell
      title="Settings"
      toolbar={
        workspace === null ? undefined : <SettingsNav workspace={workspace} />
      }
    >
      <div className="max-w-2xl space-y-4">
        <div className="flex items-end justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">Teams</h2>
            <p className="text-sm text-text-muted">
              Each team has its own key, workflow, labels and members.
            </p>
          </div>
          {create}
        </div>
        {limited && (
          <p className="text-sm text-text-muted">
            Only workspace admins can create teams in this workspace.
          </p>
        )}

        {error !== null && (
          <ErrorAlert message={errorMessage(error, 'Could not load teams.')} />
        )}

        {isLoading ? (
          <SkeletonRows count={3} label="Loading teams" />
        ) : teams.length === 0 ? (
          <EmptyState
            icon={<LuUsersRound />}
            message={
              createTeam.canCreate
                ? 'No teams yet. Create one to start filing issues.'
                : 'You are not on any team yet. An admin can add you to one.'
            }
            action={create}
            className="rounded-md border border-line py-10"
          />
        ) : (
          <table className="w-full table-fixed border-collapse text-sm">
            <caption className="sr-only">Teams in this workspace</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs text-text-faint">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Name
                </th>
                <th scope="col" className="w-24 py-2 pr-3 font-medium">
                  Key
                </th>
                <th scope="col" className="w-28 py-2 pr-3 font-medium">
                  Your role
                </th>
                <th scope="col" className="w-10 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => (
                <tr key={team.id} className="border-b border-line">
                  <td className="py-2 pr-3">
                    <Link
                      to={teamSettingsPath(slug, team.key_prefix)}
                      className="flex min-w-0 items-center gap-2 font-medium text-text hover:underline"
                    >
                      <Avatar
                        name={team.name}
                        src={team.icon_url}
                        size="sm"
                        shape="square"
                        className="h-5 w-5 text-2xs"
                      />
                      <span className="truncate">{team.name}</span>
                      {team.private === true && (
                        <LuLock
                          aria-label="Private team"
                          className="h-3 w-3 shrink-0 text-text-faint"
                        />
                      )}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs text-text-muted">
                    {team.key_prefix}
                  </td>
                  <td className="py-2 pr-3 text-text-muted">
                    {team.role === undefined ? 'None' : roleLabel(team.role)}
                  </td>
                  <td className="py-2 text-right">
                    <Menu
                      label={`${team.name} actions`}
                      align="end"
                      trigger={(props) => (
                        <IconButton
                          label={`Actions for ${team.name}`}
                          size="sm"
                          {...props}
                        >
                          <LuEllipsis className="h-3.5 w-3.5" />
                        </IconButton>
                      )}
                    >
                      <MenuItem to={teamSettingsPath(slug, team.key_prefix)}>
                        Team settings
                      </MenuItem>
                      <MenuItem to={teamPath(slug, team.key_prefix)}>
                        Open team
                      </MenuItem>
                      <MenuItem
                        onSelect={() => {
                          copyLink(teamPath(slug, team.key_prefix));
                        }}
                      >
                        Copy link
                      </MenuItem>
                    </Menu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {workspace !== null && retired.length > 0 && (
          <RetiredTeams workspace={workspace} teams={retired} />
        )}
      </div>
    </WorkspaceShell>
  );
};

export default TeamsSettings;
