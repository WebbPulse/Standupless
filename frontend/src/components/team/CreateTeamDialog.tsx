/**
 * The dialog that creates a team. The key prefix follows the name until the
 * person edits it, because a prefix derived from the name is almost always
 * what they would have typed, and it is checked with the same rule the API
 * applies so a bad prefix is caught before a request is spent.
 *
 * The create route takes no description, but the team's creator is made its
 * admin, so a description typed here is written with a follow-up update. If
 * that second write fails the team still exists and the dialog says so rather
 * than leaving the person unsure whether to try again.
 */

import React, { useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { createTeam, updateTeam } from '../../api/teams';
import { errorMessage, hasStatus, CONFLICT } from '../../lib/errors';
import { teamsKey } from '../../lib/queryKeys';
import { cn } from '../../lib/cn';
import { keyPrefixFromName, validateKeyPrefix } from '../../lib/validation';
import {
  ESTIMATE_SCALES,
  validateTeamDescription,
  validateTeamName,
} from '../../lib/teamForm';
import type { EstimateScale, TeamRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import Field from '../ui/field';
import { Textarea } from '../ui/input';
import Label from '../ui/label';
import { SelectField } from '../ui/select';

/** Props for CreateTeamDialog. */
export interface CreateTeamDialogProps {
  workspaceId: string;
  onClose: () => void;
  /**
   * Called with the new team once it exists, and a sentence to show when part
   * of the request did not land.
   */
  onCreated: (team: TeamRead, notice?: string) => void;
}

/** A form for a team's name, key prefix, description and estimate scale. */
export const CreateTeamDialog: React.FC<CreateTeamDialogProps> = ({
  workspaceId,
  onClose,
  onCreated,
}) => {
  const [name, setName] = useState('');
  const [keyPrefix, setKeyPrefix] = useState('');
  const [prefixTouched, setPrefixTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [estimateScale, setEstimateScale] = useState<EstimateScale>('off');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameError = validateTeamName(name);
  const prefixError = validateKeyPrefix(keyPrefix);
  const descriptionError = validateTeamDescription(description);
  const canSubmit =
    name.trim() !== '' &&
    keyPrefix !== '' &&
    nameError === null &&
    prefixError === null &&
    descriptionError === null &&
    !isSaving;

  const onSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canSubmit) return;
    setIsSaving(true);
    setError(null);
    let team: TeamRead;
    try {
      team = await createTeam(workspaceId, {
        name: name.trim(),
        key_prefix: keyPrefix,
        estimate_scale: estimateScale,
      });
    } catch (caught) {
      setIsSaving(false);
      setError(
        hasStatus(caught, CONFLICT)
          ? `Another team already uses ${keyPrefix}. Pick a different key.`
          : errorMessage(caught, 'Could not create the team.')
      );
      return;
    }
    if (description.trim() !== '') {
      try {
        team = await updateTeam(workspaceId, team.id, {
          description: description.trim(),
        });
      } catch {
        invalidateQueries(teamsKey(workspaceId));
        setIsSaving(false);
        onCreated(
          team,
          `${team.name} was created, but its description was not saved. Add it from the team's settings.`
        );
        return;
      }
    }
    invalidateQueries(teamsKey(workspaceId));
    setIsSaving(false);
    onCreated(team);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Create a team"
      description="Issues in a team take its key, so pick one that reads well in a sentence."
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          void onSubmit(event);
        }}
      >
        {error !== null && <ErrorAlert message={error} />}

        <div className="space-y-1">
          <Field
            id="create-team-name"
            label="Name"
            value={name}
            autoComplete="off"
            placeholder="Platform"
            aria-invalid={nameError === null ? undefined : true}
            onChange={(event) => {
              setName(event.target.value);
              if (!prefixTouched) {
                setKeyPrefix(keyPrefixFromName(event.target.value));
              }
            }}
          />
          {nameError !== null && (
            <p className="text-xs text-danger">{nameError}</p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Field
              id="create-team-key"
              label="Key"
              value={keyPrefix}
              autoComplete="off"
              spellCheck={false}
              maxLength={6}
              className="font-mono"
              aria-describedby="create-team-key-help"
              aria-invalid={prefixError === null ? undefined : true}
              onChange={(event) => {
                setPrefixTouched(true);
                setKeyPrefix(event.target.value.toUpperCase().trim());
              }}
            />
            <p
              id="create-team-key-help"
              className={cn(
                'text-xs',
                prefixError === null ? 'text-text-faint' : 'text-danger'
              )}
            >
              {prefixError ??
                `2 to 6 characters, starting with a letter. Issues read like ${keyPrefix === '' ? 'ENG' : keyPrefix}-14. The key cannot change later.`}
            </p>
          </div>

          <SelectField
            id="create-team-estimates"
            label="Estimates"
            value={estimateScale}
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
        </div>

        <div className="space-y-1">
          <Label htmlFor="create-team-description">
            Description (optional)
          </Label>
          <Textarea
            id="create-team-description"
            rows={3}
            value={description}
            placeholder="What this team works on"
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
          {descriptionError !== null && (
            <p className="text-xs text-danger">{descriptionError}</p>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            {isSaving ? 'Creating' : 'Create team'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

export default CreateTeamDialog;
