/**
 * The form that names a dashboard and says where it is filed: the caller's
 * own, one team's, or the whole workspace's. The same form edits an existing
 * dashboard, where a new location moves it.
 */

import React, { useState } from 'react';
import { DASHBOARD_SCOPES, type DashboardDetails } from '../../lib/dashboards';
import type { DashboardScope, TeamRead } from '../../types/Api';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import Field from '../ui/field';
import { Textarea } from '../ui/input';
import Label from '../ui/label';
import { Select } from '../ui/select';

/** Props for DashboardDialog. */
export interface DashboardDialogProps {
  title: string;
  submitLabel: string;
  /** The teams a dashboard can be filed under. */
  teams: TeamRead[];
  /** False for a guest, who cannot file a dashboard for the whole workspace. */
  canShareWorkspace: boolean;
  initial?: Partial<DashboardDetails>;
  onClose: () => void;
  onSave: (details: DashboardDetails) => Promise<void>;
}

/** The dashboard form in a dialog. */
export const DashboardDialog: React.FC<DashboardDialogProps> = ({
  title,
  submitLabel,
  teams,
  canShareWorkspace,
  initial = {},
  onClose,
  onSave,
}) => {
  const [name, setName] = useState(initial.name ?? '');
  const [description, setDescription] = useState(initial.description ?? '');
  const [scope, setScope] = useState<DashboardScope>(
    initial.scope ?? 'personal'
  );
  const [teamId, setTeamId] = useState(initial.teamId ?? teams[0]?.id ?? '');
  const [saving, setSaving] = useState(false);
  const scopes = DASHBOARD_SCOPES.filter(
    (option) =>
      (option.value !== 'workspace' || canShareWorkspace) &&
      (option.value !== 'team' || teams.length > 0)
  );
  const ready = name.trim() !== '' && (scope !== 'team' || teamId !== '');

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready) return;
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim() === '' ? null : description.trim(),
        scope,
        teamId: scope === 'team' ? teamId : null,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={title} size="md">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => void submit(event)}
      >
        <Field
          id="dashboard-name"
          label="Name"
          value={name}
          maxLength={80}
          required
          autoFocus
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <div className="space-y-1">
          <Label htmlFor="dashboard-description">Description</Label>
          <Textarea
            id="dashboard-description"
            value={description}
            maxLength={500}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex min-w-0 flex-col gap-1 text-xs text-text-muted">
            Visible to
            <Select
              value={scope}
              onChange={(event) => {
                setScope(event.target.value as DashboardScope);
              }}
            >
              {scopes.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value === 'personal' ? 'Only me' : option.label}
                </option>
              ))}
            </Select>
          </label>
          {scope === 'team' && (
            <label className="flex min-w-0 flex-col gap-1 text-xs text-text-muted">
              Team
              <Select
                value={teamId}
                onChange={(event) => {
                  setTeamId(event.target.value);
                }}
              >
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </Select>
            </label>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={saving || !ready}
          >
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

export default DashboardDialog;
