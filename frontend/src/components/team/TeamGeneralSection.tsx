/**
 * A team's General settings: its name, description and estimate scale, the
 * key its issues carry, and deleting the team.
 *
 * The key is shown but not editable because the API fixes it once allocated:
 * every issue key already handed out embeds it, and links in commits and pull
 * requests would stop resolving if it moved. Editing is offered to team
 * admins, which is what the update route checks, and deleting only to
 * workspace owners and admins, which is what the delete route checks, so no
 * control here leads to a refusal.
 */

import React, { useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { useNavigate } from 'react-router-dom';
import { deleteTeam, updateTeam } from '../../api/teams';
import { errorMessage } from '../../lib/errors';
import { settingsTeamsPath } from '../../lib/paths';
import { teamsKey } from '../../lib/queryKeys';
import {
  ESTIMATE_SCALES,
  validateTeamDescription,
  validateTeamName,
} from '../../lib/teamForm';
import type { EstimateScale, TeamRead } from '../../types/Api';
import { ConfirmationAlert, ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import Field from '../ui/field';
import { Textarea } from '../ui/input';
import Label from '../ui/label';
import { SelectField } from '../ui/select';

/** Props for TeamGeneralSection. */
export interface TeamGeneralSectionProps {
  workspaceId: string;
  slug: string;
  team: TeamRead;
  /** Whether the caller may edit the team: a team admin. */
  canEdit: boolean;
  /** Whether the caller may delete the team: a workspace owner or admin. */
  canDelete: boolean;
}

/** Props for the edit form, which starts from the team as last read. */
interface GeneralFormProps {
  workspaceId: string;
  team: TeamRead;
  canEdit: boolean;
  onSaved: () => void;
}

/**
 * The name, description and estimate scale form. It is keyed on the team's
 * last update so a change made elsewhere replaces the starting values rather
 * than leaving the form on stale ones.
 */
const GeneralForm: React.FC<GeneralFormProps> = ({
  workspaceId,
  team,
  canEdit,
  onSaved,
}) => {
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? '');
  const [estimateScale, setEstimateScale] = useState<EstimateScale>(
    team.estimate_scale
  );
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameError =
    name === '' ? 'Give the team a name.' : validateTeamName(name);
  const descriptionError = validateTeamDescription(description);
  const dirty =
    name.trim() !== team.name ||
    description.trim() !== (team.description ?? '') ||
    estimateScale !== team.estimate_scale;
  const canSave =
    canEdit &&
    dirty &&
    nameError === null &&
    descriptionError === null &&
    !isSaving;

  const onSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canSave) return;
    setIsSaving(true);
    setError(null);
    try {
      await updateTeam(workspaceId, team.id, {
        name: name.trim(),
        description: description.trim() === '' ? null : description.trim(),
        estimate_scale: estimateScale,
      });
      invalidateQueries(teamsKey(workspaceId));
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught, 'Could not save the team.'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        void onSubmit(event);
      }}
    >
      {error !== null && <ErrorAlert message={error} />}

      <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
        <div className="space-y-1">
          <Field
            id="team-general-name"
            label="Name"
            value={name}
            autoComplete="off"
            disabled={!canEdit}
            aria-invalid={nameError === null ? undefined : true}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          {canEdit && nameError !== null && (
            <p className="text-xs text-danger">{nameError}</p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="team-general-key">Key</Label>
          <input
            id="team-general-key"
            value={team.key_prefix}
            readOnly
            aria-describedby="team-general-key-help"
            className="flex h-8 w-full rounded-sm border border-line bg-surface px-2.5 font-mono text-sm text-text-muted focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          />
        </div>
      </div>
      <p id="team-general-key-help" className="-mt-2 text-xs text-text-faint">
        Issues in this team read like {team.key_prefix}-14. A key is fixed once
        it is allocated, so links to existing issues keep working.
      </p>

      <div className="space-y-1">
        <Label htmlFor="team-general-description">Description</Label>
        <Textarea
          id="team-general-description"
          rows={3}
          value={description}
          disabled={!canEdit}
          placeholder="What this team works on"
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
        {descriptionError !== null && (
          <p className="text-xs text-danger">{descriptionError}</p>
        )}
      </div>

      <SelectField
        id="team-general-estimates"
        label="Estimates"
        value={estimateScale}
        disabled={!canEdit}
        className="sm:w-56"
        onChange={(event) => {
          setEstimateScale(event.target.value as EstimateScale);
        }}
      >
        {ESTIMATE_SCALES.map((scale) => (
          <option key={scale.value} value={scale.value}>
            {scale.label}
          </option>
        ))}
      </SelectField>

      {canEdit && (
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={!canSave}>
            {isSaving ? 'Saving' : 'Save changes'}
          </Button>
        </div>
      )}
    </form>
  );
};

/** Props for the delete confirmation. */
interface DeleteTeamDialogProps {
  workspaceId: string;
  slug: string;
  team: TeamRead;
  onClose: () => void;
}

/**
 * Asks for the team's key before deleting it, because a deleted team takes
 * its workflow with it and cuts its issues off, and a single click is too easy
 * to make by mistake.
 */
const DeleteTeamDialog: React.FC<DeleteTeamDialogProps> = ({
  workspaceId,
  slug,
  team,
  onClose,
}) => {
  const navigate = useNavigate();
  const [typed, setTyped] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim().toUpperCase() === team.key_prefix;

  const onConfirm = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!matches || isDeleting) return;
    setIsDeleting(true);
    setError(null);
    try {
      await deleteTeam(workspaceId, team.id);
      invalidateQueries(teamsKey(workspaceId));
      void navigate(settingsTeamsPath(slug));
    } catch (caught) {
      setError(errorMessage(caught, 'Could not delete the team.'));
      setIsDeleting(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete ${team.name}`}
      description="This removes the team, its statuses and its labels. Its issues can no longer be opened from the team. It cannot be undone."
      size="sm"
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          void onConfirm(event);
        }}
      >
        {error !== null && <ErrorAlert message={error} />}
        <Field
          id="delete-team-confirm"
          label={`Type ${team.key_prefix} to confirm`}
          value={typed}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          onChange={(event) => {
            setTyped(event.target.value);
          }}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="danger"
            disabled={!matches || isDeleting}
          >
            {isDeleting ? 'Deleting' : 'Delete team'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

/** The General section of a team's settings. */
export const TeamGeneralSection: React.FC<TeamGeneralSectionProps> = ({
  workspaceId,
  slug,
  team,
  canEdit,
  canDelete,
}) => {
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">General</h3>
        <p className="text-sm text-text-muted">
          {canEdit
            ? 'How this team is named and described, and how its issues are estimated.'
            : 'Only a team admin can change these.'}
        </p>
      </div>

      {saved && <ConfirmationAlert message="Saved." />}

      <GeneralForm
        key={team.updated_at}
        workspaceId={workspaceId}
        team={team}
        canEdit={canEdit}
        onSaved={() => {
          setSaved(true);
        }}
      />

      {canDelete && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger/40 px-4 py-3">
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium text-text">Delete team</p>
            <p className="text-xs text-text-muted">
              Removes the team and its workflow. This cannot be undone.
            </p>
          </div>
          <Button
            type="button"
            variant="danger"
            onClick={() => {
              setDeleting(true);
            }}
          >
            Delete team
          </Button>
        </div>
      )}

      {deleting && (
        <DeleteTeamDialog
          workspaceId={workspaceId}
          slug={slug}
          team={team}
          onClose={() => {
            setDeleting(false);
          }}
        />
      )}
    </section>
  );
};

export default TeamGeneralSection;
