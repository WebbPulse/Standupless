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
 *
 * A team can start private, which the server allows on the Business plan only;
 * its refusal is shown as sent.
 *
 * A team can also start under a parent team, created nested in the one call so
 * it has the parent's statuses, labels, estimates and cycle settings from its
 * first moment. Teams nest one level, so the picker lists the hierarchy but
 * offers only top-level teams, and the estimate scale is left to the parent.
 */

import React, { useMemo, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { createTeam, updateTeam } from '../../api/teams';
import { errorMessage, hasStatus, CONFLICT } from '../../lib/errors';
import { teamsKey } from '../../lib/queryKeys';
import { cn } from '../../lib/cn';
import { teamTree } from '../../lib/teamOrder';
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
import Checkbox from '../ui/checkbox';
import { Combobox, type ComboboxOption } from '../ui/combobox';
import { Textarea } from '../ui/input';
import Label from '../ui/label';
import { Popover } from '../ui/popover';
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
  /** The workspace's teams the caller can see, offered as parents. */
  teams?: readonly TeamRead[];
  /** The parent team picked when the dialog opens, to create a sub-team of it. */
  initialParentTeamId?: string | null;
}

/** The picker value that stands for no parent team. */
const NO_PARENT = '__none__';

/** Props for ParentTeamPicker. */
interface ParentTeamPickerProps {
  teams: readonly TeamRead[];
  value: string | null;
  onChange: (teamId: string | null) => void;
}

/**
 * The parent team control: a chip that opens a filterable list of the team
 * hierarchy. Sub-teams show under their parents but cannot be picked, since a
 * team nests one level.
 */
const ParentTeamPicker: React.FC<ParentTeamPickerProps> = ({
  teams,
  value,
  onChange,
}) => {
  const parent = teams.find((team) => team.id === value);
  const label =
    value === null
      ? 'No parent team'
      : (parent?.name ?? 'A team you cannot see');
  const options: ComboboxOption[] = useMemo(
    () => [
      { value: NO_PARENT, label: 'No parent team' },
      ...teamTree(teams).map(({ team, nested, parentName }) => ({
        value: team.id,
        label: team.name,
        detail: nested ? 'Sub-team' : team.key_prefix,
        keywords: [
          team.key_prefix,
          ...(parentName === undefined ? [] : [parentName]),
        ],
        indent: nested,
        disabled: nested,
      })),
    ],
    [teams]
  );
  return (
    <Popover
      label="Parent team"
      contentClassName="w-64"
      trigger={(trigger) => (
        <button
          type="button"
          id="create-team-parent"
          aria-label={`Parent team: ${label}`}
          {...trigger}
          className={cn(
            'inline-flex h-7 max-w-full items-center gap-1.5 truncate rounded-sm border border-line px-2 text-sm',
            'hover:border-line-strong hover:bg-raised',
            value === null ? 'text-text-muted' : 'text-text'
          )}
        >
          {label}
        </button>
      )}
    >
      {(close) => (
        <Combobox
          label="Parent team"
          placeholder="Pick a parent team"
          options={options}
          selected={[value ?? NO_PARENT]}
          onSelect={(picked) => {
            close();
            onChange(picked === NO_PARENT ? null : picked);
          }}
        />
      )}
    </Popover>
  );
};

/** A form for a team's name, key prefix, parent, description, estimate scale and privacy. */
export const CreateTeamDialog: React.FC<CreateTeamDialogProps> = ({
  workspaceId,
  onClose,
  onCreated,
  teams = [],
  initialParentTeamId = null,
}) => {
  const [name, setName] = useState('');
  const [keyPrefix, setKeyPrefix] = useState('');
  const [prefixTouched, setPrefixTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [estimateScale, setEstimateScale] = useState<EstimateScale>('off');
  const [isPrivate, setIsPrivate] = useState(false);
  const [parentTeamId, setParentTeamId] = useState<string | null>(
    initialParentTeamId
  );
  const parent = teams.find((team) => team.id === parentTeamId);
  const subTeam = initialParentTeamId !== null;
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
        ...(parentTeamId === null
          ? { estimate_scale: estimateScale }
          : { parent_team_id: parentTeamId }),
        ...(isPrivate ? { private: true } : {}),
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
      title={subTeam ? 'Create a sub-team' : 'Create a team'}
      description={
        parentTeamId === null
          ? 'Issues in a team take its key, so pick one that reads well in a sentence.'
          : `It starts with ${parent?.name ?? 'the parent'}'s statuses, labels, estimates and cycle settings.`
      }
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

        {(teams.length > 0 || parentTeamId !== null) && (
          <div className="space-y-1">
            <Label htmlFor="create-team-parent">Parent team</Label>
            <div>
              <ParentTeamPicker
                teams={teams}
                value={parentTeamId}
                onChange={setParentTeamId}
              />
            </div>
            <p className="text-xs text-text-faint">
              Optional. Teams nest one level, so only top-level teams can be
              picked.
            </p>
          </div>
        )}

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

          {parentTeamId === null ? (
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
          ) : (
            <div className="space-y-1">
              <p className="text-sm font-medium">Estimates</p>
              <p className="text-xs text-text-faint">
                Inherited from {parent?.name ?? 'the parent team'}.
              </p>
            </div>
          )}
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

        <div className="space-y-1">
          <Checkbox
            label="Private team"
            checked={isPrivate}
            aria-describedby="create-team-private-help"
            onChange={(event) => {
              setIsPrivate(event.target.checked);
            }}
          />
          <p id="create-team-private-help" className="text-xs text-text-faint">
            Only members can see a private team and its issues, and people join
            by invite. Needs the Business plan.
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            {isSaving
              ? 'Creating'
              : subTeam
                ? 'Create sub-team'
                : 'Create team'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

export default CreateTeamDialog;
