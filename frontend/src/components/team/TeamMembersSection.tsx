/**
 * The members of one team, with the role grant and removal controls. The
 * grant route is a PUT on a user id, so a new member is added by choosing one
 * of the workspace's members who does not yet hold a team role.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  listTeamMembers,
  removeTeamMember,
  setTeamMember,
} from '../../api/teams';
import { listMembers } from '../../api/workspaces';
import { roleLabel } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { membersKey, teamMembersKey } from '../../lib/queryKeys';
import type { TeamRole } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Avatar from '../ui/avatar';
import Button from '../ui/button';
import Label from '../ui/label';
import { Select, SelectField } from '../ui/select';
import Spinner from '../ui/spinner';

/**
 * Props for TeamMembersSection: which team, whether the caller may edit,
 * and whether the caller may read the workspace roster to add from.
 */
export interface TeamMembersSectionProps {
  workspaceId: string;
  teamId: string;
  canEdit: boolean;
  canReadWorkspaceMembers: boolean;
}

/** How often the team member list is re-read while the tab is open. */
const POLL_MS = 30000;

/** The roles a team member may hold. */
const TEAM_ROLES: TeamRole[] = ['admin', 'member'];

/** The column layout the header and every row share. */
const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3';

/** Lists and edits a team's members. */
export const TeamMembersSection: React.FC<TeamMembersSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
  canReadWorkspaceMembers,
}) => {
  const auth = useQueryAuth();
  const queryKey = teamMembersKey(teamId);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<TeamRole>('member');

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listTeamMembers(workspaceId, teamId, signal),
    {
      intervalMs: POLL_MS,
      queryKey,
      auth,
    }
  );

  const { data: workspaceMembers } = usePolledQuery(
    ({ signal }) => listMembers(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: canEdit && canReadWorkspaceMembers,
      queryKey: membersKey(workspaceId),
      auth,
    }
  );

  const {
    mutate: grant,
    isMutating,
    error: grantError,
  } = useMutationWithRefetch(
    (targetId: string, targetRole: TeamRole) =>
      setTeamMember(workspaceId, teamId, targetId, { role: targetRole }),
    queryKey
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    (targetId: string) => removeTeamMember(workspaceId, teamId, targetId),
    queryKey
  );

  const existing = new Set((data ?? []).map((member) => member.user_id));
  const addable = (workspaceMembers ?? []).filter(
    (member) => !existing.has(member.user_id)
  );
  const canSubmit = userId !== '' && !isMutating;

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    void grant(userId, role)
      .then(() => {
        setUserId('');
        setRole('member');
      })
      .catch(() => undefined);
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Team members</h3>
        <p className="text-sm text-text-muted">
          People who hold a role on this team directly, on top of what the
          workspace gives them.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the team members.')}
        />
      )}
      {grantError !== null && (
        <ErrorAlert
          message={errorMessage(grantError, 'Could not set that role.')}
        />
      )}
      {removeError !== null && (
        <ErrorAlert
          message={errorMessage(removeError, 'Could not remove that member.')}
        />
      )}

      {isLoading || data === null ? (
        <Spinner label="Loading team members" />
      ) : data.length === 0 ? (
        <p className="text-sm text-text-muted">
          No one holds a role on this team directly.
        </p>
      ) : (
        <div className="rounded-md border border-line">
          <div
            className={`${COLUMNS} h-8 border-b border-line bg-surface text-xs font-medium text-text-muted`}
          >
            <span>Member</span>
            <span>Role</span>
          </div>
          <ul>
            {data.map((member) => (
              <li
                key={member.user_id}
                className={`${COLUMNS} min-h-row border-b border-line py-1 transition-colors duration-100 last:border-b-0 hover:bg-surface`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Avatar
                    name={member.display_name ?? member.email}
                    size="sm"
                  />
                  <div className="min-w-0">
                    <p className="truncate font-medium text-text">
                      {member.display_name ?? member.email}
                    </p>
                    <p className="hidden truncate text-xs text-text-muted sm:block">
                      {member.email}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {canEdit ? (
                    <Select
                      aria-label={`Team role for ${member.email}`}
                      className="w-28"
                      value={member.role}
                      onChange={(event) => {
                        void grant(
                          member.user_id,
                          event.target.value as TeamRole
                        ).catch(() => undefined);
                      }}
                    >
                      {TEAM_ROLES.map((item) => (
                        <option key={item} value={item}>
                          {roleLabel(item)}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <span className="text-xs text-text-muted">
                      {roleLabel(member.role)}
                    </span>
                  )}
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void remove(member.user_id).catch(() => undefined);
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {canEdit && canReadWorkspaceMembers && addable.length > 0 && (
        <form
          className="space-y-4 rounded-md border border-line p-4"
          onSubmit={onSubmit}
        >
          <div className="grid max-w-md gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <div className="space-y-1">
              <Label htmlFor="team-member-user">Add a member</Label>
              <Select
                id="team-member-user"
                value={userId}
                onChange={(event) => {
                  setUserId(event.target.value);
                }}
              >
                <option value="">Choose someone</option>
                {addable.map((member) => (
                  <option key={member.user_id} value={member.user_id}>
                    {member.display_name ?? member.email}
                  </option>
                ))}
              </Select>
            </div>

            <SelectField
              id="team-member-role"
              label="Role"
              value={role}
              onChange={(event) => {
                setRole(event.target.value as TeamRole);
              }}
            >
              {TEAM_ROLES.map((item) => (
                <option key={item} value={item}>
                  {roleLabel(item)}
                </option>
              ))}
            </SelectField>
          </div>

          <Button type="submit" variant="primary" disabled={!canSubmit}>
            {isMutating ? 'Adding' : 'Add to team'}
          </Button>
        </form>
      )}
    </section>
  );
};

export default TeamMembersSection;
