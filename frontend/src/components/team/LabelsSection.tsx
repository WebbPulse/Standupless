/**
 * The labels of one team: adding, renaming and recolouring them. The colour
 * is a native colour input, which produces the `#rrggbb` the contract fixes
 * without a picker dependency.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  createLabel,
  deleteLabel,
  listLabels,
  updateLabel,
} from '../../api/teams';
import { errorMessage } from '../../lib/errors';
import { labelsKey } from '../../lib/queryKeys';
import type { LabelRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import { LabelChip } from '../ui/badge';
import Button from '../ui/button';
import Field from '../ui/field';
import Label from '../ui/label';
import Spinner from '../ui/spinner';

/** Props for LabelsSection: which team, and whether the caller may edit. */
export interface LabelsSectionProps {
  workspaceId: string;
  teamId: string;
  canEdit: boolean;
}

/** How often the label list is re-read while the settings tab is open. */
const POLL_MS = 30000;

/** The colour a new label starts on. */
const DEFAULT_COLOR = '#3b82f6';

/** The compact native colour input used beside a label's name. */
const COLOR_INPUT_CLASS =
  'h-7 w-9 cursor-pointer rounded-sm border border-line-strong bg-bg p-0.5';

/** Lists and edits a team's labels. */
export const LabelsSection: React.FC<LabelsSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
}) => {
  const auth = useQueryAuth();
  const queryKey = labelsKey(teamId);
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_COLOR);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listLabels(workspaceId, teamId, signal),
    {
      intervalMs: POLL_MS,
      queryKey,
      auth,
    }
  );

  const {
    mutate: add,
    isMutating,
    error: addError,
  } = useMutationWithRefetch(
    (body: { name: string; color: string }) =>
      createLabel(workspaceId, teamId, body),
    queryKey
  );

  const { mutate: edit, error: editError } = useMutationWithRefetch(
    (labelId: string, body: { name?: string; color?: string }) =>
      updateLabel(workspaceId, teamId, labelId, body),
    queryKey
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    (labelId: string) => deleteLabel(workspaceId, teamId, labelId),
    queryKey
  );

  const canSubmit = name.trim() !== '' && !isMutating;

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    void add({ name: name.trim(), color })
      .then(() => {
        setName('');
        setColor(DEFAULT_COLOR);
      })
      .catch(() => undefined);
  };

  const onRename = (label: LabelRead, value: string): void => {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === label.name) return;
    void edit(label.id, { name: trimmed }).catch(() => undefined);
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Labels</h3>
        <p className="text-sm text-text-muted">
          Labels tag issues in this team, each with a colour of its own.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the labels.')}
        />
      )}
      {editError !== null && (
        <ErrorAlert
          message={errorMessage(editError, 'Could not update that label.')}
        />
      )}
      {removeError !== null && (
        <ErrorAlert
          message={errorMessage(removeError, 'Could not delete that label.')}
        />
      )}

      {isLoading || data === null ? (
        <Spinner label="Loading labels" />
      ) : data.length === 0 ? (
        <p className="text-sm text-text-muted">This team has no labels.</p>
      ) : (
        <ul className="rounded-md border border-line">
          {data.map((label) => (
            <li
              key={label.id}
              className="flex min-h-row items-center gap-3 border-b border-line px-3 py-1 transition-colors duration-100 last:border-b-0 hover:bg-surface"
            >
              <LabelChip color={label.color} name={label.name} />
              {canEdit && (
                <div className="ml-auto flex items-center gap-2">
                  <Field
                    id={`label-name-${label.id}`}
                    label="Name"
                    hideLabel
                    className="w-40"
                    defaultValue={label.name}
                    onBlur={(event) => {
                      onRename(label, event.target.value);
                    }}
                  />
                  <Label htmlFor={`label-color-${label.id}`} hidden>
                    Colour
                  </Label>
                  <input
                    id={`label-color-${label.id}`}
                    type="color"
                    className={COLOR_INPUT_CLASS}
                    defaultValue={label.color}
                    onBlur={(event) => {
                      if (event.target.value === label.color) return;
                      void edit(label.id, {
                        color: event.target.value,
                      }).catch(() => undefined);
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void remove(label.id).catch(() => undefined);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <form
          className="space-y-4 rounded-md border border-line p-4"
          onSubmit={onSubmit}
        >
          <h4 className="text-sm font-medium">Add a label</h4>
          {addError !== null && (
            <ErrorAlert
              message={errorMessage(addError, 'Could not add that label.')}
            />
          )}
          <div className="flex flex-wrap items-end gap-3">
            <Field
              id="new-label-name"
              label="New label"
              className="w-48"
              value={name}
              autoComplete="off"
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            <div className="space-y-1">
              <Label htmlFor="new-label-color">Colour</Label>
              <input
                id="new-label-color"
                type="color"
                className={`${COLOR_INPUT_CLASS} block h-8`}
                value={color}
                onChange={(event) => {
                  setColor(event.target.value);
                }}
              />
            </div>
            <Button type="submit" variant="primary" disabled={!canSubmit}>
              {isMutating ? 'Adding' : 'Add label'}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
};

export default LabelsSection;
