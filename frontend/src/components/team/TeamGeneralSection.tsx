/**
 * A team's General settings: its icon, name, description, estimate scale and
 * estimate toggles, and the key its issues carry. Deleting the team is the
 * danger zone at the bottom of the settings page.
 *
 * The key is shown but not editable because the API fixes it once allocated:
 * every issue key already handed out embeds it, and links in commits and pull
 * requests would stop resolving if it moved. Editing is offered to team
 * admins, which is what the update route checks, so no control here leads to
 * a refusal.
 */

import React, { useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { Link } from 'react-router-dom';
import { teamIcon, uploadIcon } from '../../api/icons';
import { updateTeam } from '../../api/teams';
import { errorMessage } from '../../lib/errors';
import { teamsKey } from '../../lib/queryKeys';
import { EXTENDED_ESTIMATE_CHOICES } from '../../lib/validation';
import {
  ESTIMATE_SCALES,
  validateTeamDescription,
  validateTeamName,
} from '../../lib/teamForm';
import type { EstimateScale, TeamRead } from '../../types/Api';
import { ConfirmationAlert, ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Checkbox from '../ui/checkbox';
import Field from '../ui/field';
import IconUploader from '../ui/icon-uploader';
import { Textarea } from '../ui/input';
import Label from '../ui/label';
import { SelectField } from '../ui/select';

/** Props for TeamGeneralSection. */
export interface TeamGeneralSectionProps {
  workspaceId: string;
  team: TeamRead;
  /** Whether the caller may edit the team: a team admin. */
  canEdit: boolean;
  /** The parent team's settings page, for a sub-team whose estimates come from the parent. */
  parentSettingsPath?: string | undefined;
}

/** Props for the edit form, which starts from the team as last read. */
interface GeneralFormProps {
  workspaceId: string;
  team: TeamRead;
  canEdit: boolean;
  parentSettingsPath?: string | undefined;
  onSaved: () => void;
}

/** The values the extended toggle adds to a scale, as a short phrase. */
const extendedPhrase = (scale: EstimateScale): string => {
  const values = EXTENDED_ESTIMATE_CHOICES[scale];
  return values.length === 0 ? 'larger values' : values.join(' and ');
};

/**
 * The name, description and estimate settings form. It is keyed on the team's
 * last update so a change made elsewhere replaces the starting values rather
 * than leaving the form on stale ones.
 */
const GeneralForm: React.FC<GeneralFormProps> = ({
  workspaceId,
  team,
  canEdit,
  parentSettingsPath,
  onSaved,
}) => {
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? '');
  const [estimateScale, setEstimateScale] = useState<EstimateScale>(
    team.estimate_scale
  );
  const [extended, setExtended] = useState(team.estimate_extended ?? false);
  const [allowZero, setAllowZero] = useState(team.estimate_allow_zero ?? false);
  const [countUnestimated, setCountUnestimated] = useState(
    team.estimate_count_unestimated ?? false
  );
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameError =
    name === '' ? 'Give the team a name.' : validateTeamName(name);
  const descriptionError = validateTeamDescription(description);
  const dirty =
    name.trim() !== team.name ||
    description.trim() !== (team.description ?? '') ||
    estimateScale !== team.estimate_scale ||
    extended !== (team.estimate_extended ?? false) ||
    allowZero !== (team.estimate_allow_zero ?? false) ||
    countUnestimated !== (team.estimate_count_unestimated ?? false);
  const estimatesOn = estimateScale !== 'off';
  const inherited =
    team.parent_team_id !== undefined && team.parent_team_id !== null;
  const estimatesLocked = !canEdit || inherited;
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
        estimate_extended: extended,
        estimate_allow_zero: allowZero,
        estimate_count_unestimated: countUnestimated,
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
        disabled={estimatesLocked}
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
      {inherited && (
        <p className="text-xs text-text-faint">
          This sub-team uses its parent team's estimates. Change them in the{' '}
          {parentSettingsPath === undefined ? (
            "parent team's settings"
          ) : (
            <Link
              to={`${parentSettingsPath}#team-settings-general`}
              className="text-accent hover:underline"
            >
              parent team's settings
            </Link>
          )}
          .
        </p>
      )}

      {estimatesOn && (
        <fieldset className="space-y-2">
          <legend className="sr-only">Estimate options</legend>
          <Checkbox
            label={`Extended range: add ${extendedPhrase(estimateScale)}`}
            checked={extended}
            disabled={estimatesLocked}
            onChange={(event) => {
              setExtended(event.target.checked);
            }}
          />
          <Checkbox
            label="Allow zero: add 0 for work that takes no effort"
            checked={allowZero}
            disabled={estimatesLocked}
            onChange={(event) => {
              setAllowZero(event.target.checked);
            }}
          />
          <Checkbox
            label="Count unestimated issues as 1 point in cycle and project progress"
            checked={countUnestimated}
            disabled={estimatesLocked}
            onChange={(event) => {
              setCountUnestimated(event.target.checked);
            }}
          />
          <p className="text-xs text-text-faint">
            Changing the scale keeps every estimate issues already hold. One the
            new scale does not offer is flagged in the estimate picker.
          </p>
        </fieldset>
      )}

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

/** The General section of a team's settings. */
export const TeamGeneralSection: React.FC<TeamGeneralSectionProps> = ({
  workspaceId,
  team,
  canEdit,
  parentSettingsPath,
}) => {
  const [saved, setSaved] = useState(false);

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">General</h3>
        <p className="text-sm text-text-muted">
          {canEdit
            ? 'How this team looks, is named and described, and how its issues are estimated.'
            : 'Only a team admin can change these.'}
        </p>
      </div>

      {saved && <ConfirmationAlert message="Saved." />}

      <IconUploader
        label="Team icon"
        description="Shown beside the team in the sidebar and the team list. PNG, JPEG, GIF or WebP, up to 2 MB."
        name={team.name}
        src={team.icon_url}
        shape="square"
        canEdit={canEdit}
        onUpload={async (file) => {
          await uploadIcon(teamIcon(workspaceId, team.id), file);
          invalidateQueries(teamsKey(workspaceId));
        }}
        onRemove={async () => {
          await teamIcon(workspaceId, team.id).clear();
          invalidateQueries(teamsKey(workspaceId));
        }}
      />

      <GeneralForm
        key={team.updated_at}
        workspaceId={workspaceId}
        team={team}
        canEdit={canEdit}
        parentSettingsPath={parentSettingsPath}
        onSaved={() => {
          setSaved(true);
        }}
      />
    </section>
  );
};

export default TeamGeneralSection;
