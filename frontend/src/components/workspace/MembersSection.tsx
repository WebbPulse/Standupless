/**
 * The member list of one workspace, with the role change and removal controls.
 * Controls are hidden by the caller's role for clarity only; the API authorizes
 * every call and refuses anything that reaches it without the standing.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import { listMembers, removeMember, updateMember } from '../../api/workspaces';
import {
  assignableRoles,
  canManageMembers,
  roleLabel,
} from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { membersKey } from '../../lib/queryKeys';
import type { WorkspaceRead, WorkspaceRole } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import { Select } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for MembersSection: the workspace whose members are shown. */
export interface MembersSectionProps {
  workspace: WorkspaceRead;
}

/** How often the member list is re-read while the settings page is open. */
const POLL_MS = 30000;

/** Lists the workspace's members and changes or removes them. */
export const MembersSection: React.FC<MembersSectionProps> = ({
  workspace,
}) => {
  const auth = useQueryAuth();
  const queryKey = membersKey(workspace.id);
  const manages = canManageMembers(workspace.role);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listMembers(workspace.id, signal),
    {
      intervalMs: POLL_MS,
      queryKey,
      auth,
    }
  );

  const { mutate: changeRole, error: roleError } = useMutationWithRefetch(
    (userId: string, role: WorkspaceRole) =>
      updateMember(workspace.id, userId, { role }),
    queryKey
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    (userId: string) => removeMember(workspace.id, userId),
    queryKey
  );

  const roles = assignableRoles(workspace.role);

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium text-white">Members</h2>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the members.')}
        />
      )}
      {roleError !== null && (
        <ErrorAlert
          message={errorMessage(roleError, 'Could not change that role.')}
        />
      )}
      {removeError !== null && (
        <ErrorAlert
          message={errorMessage(removeError, 'Could not remove that member.')}
        />
      )}

      {isLoading || data === null ? (
        <Spinner label="Loading members" />
      ) : data.length === 0 ? (
        <p className="text-sm text-slate-400">This workspace has no members.</p>
      ) : (
        <ul className="space-y-2">
          {data.map((member) => (
            <li
              key={member.user_id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-700 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-slate-100">
                  {member.display_name ?? member.email}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {member.email}
                </p>
              </div>

              <div className="flex items-center gap-2">
                {manages ? (
                  <Select
                    aria-label={`Role for ${member.email}`}
                    className="w-auto"
                    value={member.role}
                    onChange={(event) => {
                      void changeRole(
                        member.user_id,
                        event.target.value as WorkspaceRole
                      ).catch(() => undefined);
                    }}
                  >
                    {(roles.includes(member.role)
                      ? roles
                      : [member.role, ...roles]
                    ).map((role) => (
                      <option key={role} value={role}>
                        {roleLabel(role)}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span className="text-xs text-slate-400">
                    {roleLabel(member.role)}
                  </span>
                )}

                {manages && (
                  <Button
                    variant="secondary"
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
      )}
    </section>
  );
};

export default MembersSection;
