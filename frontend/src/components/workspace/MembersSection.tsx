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
import Avatar from '../ui/avatar';
import Button from '../ui/button';
import { Select } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for MembersSection: the workspace whose members are shown. */
export interface MembersSectionProps {
  workspace: WorkspaceRead;
}

/** How often the member list is re-read while the settings page is open. */
const POLL_MS = 30000;

/** The column layout the header and every row share. */
const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3';

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
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Members</h2>
        <p className="text-sm text-text-muted">
          Everyone in this workspace, with the role they hold across it.
        </p>
      </div>

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
        <p className="text-sm text-text-muted">
          This workspace has no members.
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
                  <Avatar name={member.display_name ?? member.email} />
                  <span className="truncate text-sm font-medium">
                    {member.display_name ?? member.email}
                  </span>
                  <span className="hidden min-w-0 truncate text-xs text-text-muted sm:inline">
                    {member.email}
                  </span>
                </div>

                <div className="flex items-center gap-1">
                  {manages ? (
                    <Select
                      aria-label={`Role for ${member.email}`}
                      className="w-28"
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
                    <span className="text-xs text-text-muted">
                      {roleLabel(member.role)}
                    </span>
                  )}

                  {manages && (
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
    </section>
  );
};

export default MembersSection;
