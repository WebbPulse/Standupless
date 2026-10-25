/**
 * Who may invite people and who may create teams, as Linear's workspace
 * security settings keep them. Each is admins only or every member, and a
 * guest may do neither whatever is picked. Invites start admins only and team
 * creation starts open to members, which is how the workspace behaved before
 * either setting existed.
 */

import React, { useState } from 'react';
import { updateWorkspace } from '../../api/workspaces';
import { useWorkspace } from '../../hooks/useWorkspace';
import type {
  PermissionLevel,
  WorkspaceRead,
  WorkspaceUpdate,
} from '../../types/Api';
import { SelectField } from '../ui/select';

/** The two settings this section edits. */
type PermissionField = 'invite_permission' | 'team_creation_permission';

/** One setting's select: its field, label, help and default. */
interface PermissionRow {
  field: PermissionField;
  label: string;
  help: string;
  fallback: PermissionLevel;
}

/** The settings in the order they show. */
const ROWS: PermissionRow[] = [
  {
    field: 'invite_permission',
    label: 'Invite members',
    help: 'Who may send invites. Members may invite as a member or a guest, never as an admin.',
    fallback: 'admins',
  },
  {
    field: 'team_creation_permission',
    label: 'Create teams',
    help: 'Who may create new teams. Guests never can.',
    fallback: 'members',
  },
];

/** The choices each setting offers. */
const LEVELS: { value: PermissionLevel; label: string }[] = [
  { value: 'admins', label: 'Admins only' },
  { value: 'members', label: 'All members' },
];

/** Props for PermissionsSection: the workspace whose settings are shown. */
export interface PermissionsSectionProps {
  workspace: WorkspaceRead;
}

/** Picks each permission, saves it, then re-reads the workspace. */
export const PermissionsSection: React.FC<PermissionsSectionProps> = ({
  workspace,
}) => {
  const { refresh } = useWorkspace();
  const [pending, setPending] = useState<Partial<
    Record<PermissionField, PermissionLevel>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shown = (row: PermissionRow): PermissionLevel =>
    pending?.[row.field] ?? workspace[row.field] ?? row.fallback;

  const save = async (
    field: PermissionField,
    level: PermissionLevel
  ): Promise<void> => {
    const body: WorkspaceUpdate = { [field]: level };
    setPending({ [field]: level });
    setError(null);
    try {
      await updateWorkspace(workspace.id, body);
      await refresh();
    } catch {
      setError('Could not save that permission. Try again.');
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Permissions</h3>
        <p className="text-sm text-text-muted">
          Choose whether only admins or every member may invite people and
          create teams.
        </p>
      </div>
      {ROWS.map((row) => (
        <div key={row.field} className="space-y-1">
          <SelectField
            id={`workspace-${row.field}`}
            label={row.label}
            className="max-w-xs"
            value={shown(row)}
            disabled={pending !== null}
            onChange={(event) => {
              void save(row.field, event.target.value as PermissionLevel);
            }}
          >
            {LEVELS.map((level) => (
              <option key={level.value} value={level.value}>
                {level.label}
              </option>
            ))}
          </SelectField>
          <p className="text-xs text-text-muted">{row.help}</p>
        </div>
      ))}
      {error !== null && <p className="text-sm text-danger">{error}</p>}
    </section>
  );
};

export default PermissionsSection;
