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
 */

import React from 'react';
import { LuEllipsis, LuPlus, LuUsersRound } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import Avatar from '../../components/ui/avatar';
import Button, { IconButton } from '../../components/ui/button';
import { ErrorAlert } from '../../components/ui/alert';
import EmptyState from '../../components/ui/empty-state';
import Menu, { MenuItem } from '../../components/ui/menu';
import { SkeletonRows } from '../../components/ui/skeleton';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useCreateTeam } from '../../hooks/useCreateTeam';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { roleLabel } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { teamPath, teamSettingsPath } from '../../lib/paths';

/** Copies an in-application path as a full link, ignoring a refused clipboard. */
const copyLink = (path: string): void => {
  void globalThis.navigator.clipboard
    .writeText(`${globalThis.location.origin}${path}`)
    .catch(() => undefined);
};

/** The list of teams with their keys, the caller's role and row actions. */
const TeamsSettings: React.FC = () => {
  const { workspace } = useWorkspace();
  const { teams, isLoading, error } = useTeam(undefined);
  const createTeam = useCreateTeam();
  const slug = workspace?.slug ?? '';

  const create = createTeam.canCreate ? (
    <Button type="button" variant="primary" size="sm" onClick={createTeam.open}>
      <LuPlus aria-hidden="true" className="h-3.5 w-3.5" />
      Create team
    </Button>
  ) : undefined;

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
                        size="sm"
                        className="h-5 w-5 rounded-xs text-2xs"
                      />
                      <span className="truncate">{team.name}</span>
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
      </div>
    </WorkspaceShell>
  );
};

export default TeamsSettings;
