/**
 * The labels of one project: adding, renaming and recolouring them. The colour
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
} from '../../api/projects';
import { errorMessage } from '../../lib/errors';
import { labelsKey } from '../../lib/queryKeys';
import type { LabelRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Field from '../ui/field';
import Spinner from '../ui/spinner';

/** Props for LabelsSection: which project, and whether the caller may edit. */
export interface LabelsSectionProps {
  workspaceId: string;
  projectId: string;
  canEdit: boolean;
}

/** How often the label list is re-read while the settings tab is open. */
const POLL_MS = 30000;

/** The colour a new label starts on. */
const DEFAULT_COLOR = '#3b82f6';

/** Lists and edits a project's labels. */
export const LabelsSection: React.FC<LabelsSectionProps> = ({
  workspaceId,
  projectId,
  canEdit,
}) => {
  const auth = useQueryAuth();
  const queryKey = labelsKey(projectId);
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_COLOR);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listLabels(workspaceId, projectId, signal),
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
      createLabel(workspaceId, projectId, body),
    queryKey
  );

  const { mutate: edit, error: editError } = useMutationWithRefetch(
    (labelId: string, body: { name?: string; color?: string }) =>
      updateLabel(workspaceId, projectId, labelId, body),
    queryKey
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    (labelId: string) => deleteLabel(workspaceId, projectId, labelId),
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
      <h3 className="text-base font-medium text-white">Labels</h3>

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
        <p className="text-sm text-slate-400">This project has no labels.</p>
      ) : (
        <ul className="space-y-2">
          {data.map((label) => (
            <li
              key={label.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-slate-700 px-3 py-2"
            >
              {canEdit ? (
                <>
                  <Field
                    id={`label-name-${label.id}`}
                    label="Name"
                    className="w-40"
                    defaultValue={label.name}
                    onBlur={(event) => {
                      onRename(label, event.target.value);
                    }}
                  />
                  <div className="space-y-1">
                    <label
                      htmlFor={`label-color-${label.id}`}
                      className="block text-sm font-medium text-slate-200"
                    >
                      Colour
                    </label>
                    <input
                      id={`label-color-${label.id}`}
                      type="color"
                      className="h-9 w-14 rounded-md border border-slate-600 bg-slate-900"
                      defaultValue={label.color}
                      onBlur={(event) => {
                        if (event.target.value === label.color) return;
                        void edit(label.id, {
                          color: event.target.value,
                        }).catch(() => undefined);
                      }}
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        void remove(label.id).catch(() => undefined);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: label.color }}
                  />
                  <span className="text-sm text-slate-100">{label.name}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <form
          className="flex flex-wrap items-end gap-2 rounded-md border border-slate-700 p-4"
          onSubmit={onSubmit}
        >
          <Field
            id="new-label-name"
            label="New label"
            className="w-40"
            value={name}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <div className="space-y-1">
            <label
              htmlFor="new-label-color"
              className="block text-sm font-medium text-slate-200"
            >
              Colour
            </label>
            <input
              id="new-label-color"
              type="color"
              className="h-9 w-14 rounded-md border border-slate-600 bg-slate-900"
              value={color}
              onChange={(event) => {
                setColor(event.target.value);
              }}
            />
          </div>
          <Button type="submit" disabled={!canSubmit}>
            {isMutating ? 'Adding' : 'Add label'}
          </Button>
          {addError !== null && (
            <ErrorAlert
              message={errorMessage(addError, 'Could not add that label.')}
            />
          )}
        </form>
      )}
    </section>
  );
};

export default LabelsSection;
