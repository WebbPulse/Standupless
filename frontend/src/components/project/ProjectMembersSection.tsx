/**
 * The members of one project, with the role grant and removal controls. The
 * grant route is a PUT on a user id, so a new member is added by choosing one
 * of the workspace's members who does not yet hold a project role.
 */

import React, { useState } from 'react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  listProjectMembers,
  removeProjectMember,
  setProjectMember,
} from '../../api/projects';
import { listMembers } from '../../api/workspaces';
import { useQueryAuth } from '../../hooks/useQueryAuth';
import { roleLabel } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { membersKey, projectMembersKey } from '../../lib/queryKeys';
import type { ProjectRole } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import { Select, SelectField } from '../ui/select';
import Spinner from '../ui/spinner';

/**
 * Props for ProjectMembersSection: which project, whether the caller may edit,
 * and whether the caller may read the workspace roster to add from.
 */
export interface ProjectMembersSectionProps {
  workspaceId: string;
  projectId: string;
  canEdit: boolean;
  canReadWorkspaceMembers: boolean;
}

/** How often the project member list is re-read while the tab is open. */
const POLL_MS = 30000;

/** The roles a project member may hold. */
const PROJECT_ROLES: ProjectRole[] = ['admin', 'member'];

/** Lists and edits a project's members. */
export const ProjectMembersSection: React.FC<ProjectMembersSectionProps> = ({
  workspaceId,
  projectId,
  canEdit,
  canReadWorkspaceMembers,
}) => {
  const auth = useQueryAuth();
  const queryKey = projectMembersKey(projectId);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<ProjectRole>('member');

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listProjectMembers(workspaceId, projectId, signal),
    {
      intervalMs: POLL_MS,
      queryKey,
      ...(auth === undefined ? {} : { auth }),
    }
  );

  const { data: workspaceMembers } = usePolledQuery(
    ({ signal }) => listMembers(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: canEdit && canReadWorkspaceMembers,
      queryKey: membersKey(workspaceId),
      ...(auth === undefined ? {} : { auth }),
    }
  );

  const {
    mutate: grant,
    isMutating,
    error: grantError,
  } = useMutationWithRefetch(
    (targetId: string, targetRole: ProjectRole) =>
      setProjectMember(workspaceId, projectId, targetId, { role: targetRole }),
    queryKey
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    (targetId: string) => removeProjectMember(workspaceId, projectId, targetId),
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
      <h3 className="text-base font-medium text-white">Project members</h3>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the project members.')}
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
        <Spinner label="Loading project members" />
      ) : data.length === 0 ? (
        <p className="text-sm text-slate-400">
          No one holds a role on this project directly.
        </p>
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
                {canEdit ? (
                  <Select
                    aria-label={`Project role for ${member.email}`}
                    className="w-auto"
                    value={member.role}
                    onChange={(event) => {
                      void grant(
                        member.user_id,
                        event.target.value as ProjectRole
                      ).catch(() => undefined);
                    }}
                  >
                    {PROJECT_ROLES.map((item) => (
                      <option key={item} value={item}>
                        {roleLabel(item)}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span className="text-xs text-slate-400">
                    {roleLabel(member.role)}
                  </span>
                )}
                {canEdit && (
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

      {canEdit && canReadWorkspaceMembers && addable.length > 0 && (
        <form
          className="flex flex-wrap items-end gap-2 rounded-md border border-slate-700 p-4"
          onSubmit={onSubmit}
        >
          <div className="w-56">
            <label
              htmlFor="project-member-user"
              className="block text-sm font-medium text-slate-200"
            >
              Add a member
            </label>
            <Select
              id="project-member-user"
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
            id="project-member-role"
            label="Role"
            className="w-auto"
            value={role}
            onChange={(event) => {
              setRole(event.target.value as ProjectRole);
            }}
          >
            {PROJECT_ROLES.map((item) => (
              <option key={item} value={item}>
                {roleLabel(item)}
              </option>
            ))}
          </SelectField>

          <Button type="submit" disabled={!canSubmit}>
            {isMutating ? 'Adding' : 'Add to project'}
          </Button>
        </form>
      )}
    </section>
  );
};

export default ProjectMembersSection;
