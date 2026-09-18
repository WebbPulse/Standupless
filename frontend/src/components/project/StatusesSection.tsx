/**
 * The workflow statuses of one project: adding, renaming, recategorising and
 * reordering them. Reordering is a position PATCH on the two statuses that swap
 * places, because the contract exposes position on the status itself and has no
 * bulk reorder route.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  createStatus,
  deleteStatus,
  listStatuses,
  updateStatus,
} from '../../api/projects';
import { errorMessage } from '../../lib/errors';
import { statusesKey } from '../../lib/queryKeys';
import type { StatusCategory, StatusRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Field from '../ui/field';
import { Select, SelectField } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for StatusesSection: which project, and whether the caller may edit. */
export interface StatusesSectionProps {
  workspaceId: string;
  projectId: string;
  canEdit: boolean;
}

/** How often the status list is re-read while the settings tab is open. */
const POLL_MS = 30000;

/** The categories the contract allows, with their interface wording. */
const CATEGORIES: { value: StatusCategory; label: string }[] = [
  { value: 'backlog', label: 'Backlog' },
  { value: 'unstarted', label: 'Unstarted' },
  { value: 'started', label: 'Started' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

/** Lists and edits a project's workflow statuses. */
export const StatusesSection: React.FC<StatusesSectionProps> = ({
  workspaceId,
  projectId,
  canEdit,
}) => {
  const auth = useQueryAuth();
  const queryKey = statusesKey(projectId);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<StatusCategory>('unstarted');

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listStatuses(workspaceId, projectId, signal),
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
    (body: { name: string; category: StatusCategory; position: number }) =>
      createStatus(workspaceId, projectId, body),
    queryKey
  );

  const { mutate: edit, error: editError } = useMutationWithRefetch(
    (statusId: string, body: { name?: string; category?: StatusCategory }) =>
      updateStatus(workspaceId, projectId, statusId, body),
    queryKey
  );

  const { mutate: swap, error: swapError } = useMutationWithRefetch(
    async (first: StatusRead, second: StatusRead) => {
      await updateStatus(workspaceId, projectId, first.id, {
        position: second.position,
      });
      await updateStatus(workspaceId, projectId, second.id, {
        position: first.position,
      });
    },
    queryKey
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    (statusId: string) => deleteStatus(workspaceId, projectId, statusId),
    queryKey
  );

  const statuses = data ?? [];
  const nextPosition =
    statuses.length === 0
      ? 0
      : Math.max(...statuses.map((item) => item.position)) + 1;
  const canSubmit = name.trim() !== '' && !isMutating;

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    void add({ name: name.trim(), category, position: nextPosition })
      .then(() => {
        setName('');
        setCategory('unstarted');
      })
      .catch(() => undefined);
  };

  const onRename = (status: StatusRead, value: string): void => {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === status.name) return;
    void edit(status.id, { name: trimmed }).catch(() => undefined);
  };

  return (
    <section className="space-y-4">
      <h3 className="text-base font-medium text-white">Statuses</h3>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the statuses.')}
        />
      )}
      {editError !== null && (
        <ErrorAlert
          message={errorMessage(editError, 'Could not update that status.')}
        />
      )}
      {swapError !== null && (
        <ErrorAlert
          message={errorMessage(swapError, 'Could not reorder the statuses.')}
        />
      )}
      {removeError !== null && (
        <ErrorAlert
          message={errorMessage(
            removeError,
            'Could not delete that status. A category must keep at least one.'
          )}
        />
      )}

      {isLoading || data === null ? (
        <Spinner label="Loading statuses" />
      ) : statuses.length === 0 ? (
        <p className="text-sm text-slate-400">This project has no statuses.</p>
      ) : (
        <ul className="space-y-2">
          {statuses.map((status, index) => (
            <li
              key={status.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-slate-700 px-3 py-2"
            >
              {canEdit ? (
                <>
                  <Field
                    id={`status-name-${status.id}`}
                    label="Name"
                    className="w-40"
                    defaultValue={status.name}
                    onBlur={(event) => {
                      onRename(status, event.target.value);
                    }}
                  />
                  <SelectField
                    id={`status-category-${status.id}`}
                    label="Category"
                    className="w-auto"
                    value={status.category}
                    onChange={(event) => {
                      void edit(status.id, {
                        category: event.target.value as StatusCategory,
                      }).catch(() => undefined);
                    }}
                  >
                    {CATEGORIES.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </SelectField>
                  <div className="flex items-end gap-1">
                    <Button
                      variant="secondary"
                      aria-label={`Move ${status.name} up`}
                      disabled={index === 0}
                      onClick={() => {
                        const previous = statuses[index - 1];
                        if (previous === undefined) return;
                        void swap(status, previous).catch(() => undefined);
                      }}
                    >
                      Up
                    </Button>
                    <Button
                      variant="secondary"
                      aria-label={`Move ${status.name} down`}
                      disabled={index === statuses.length - 1}
                      onClick={() => {
                        const next = statuses[index + 1];
                        if (next === undefined) return;
                        void swap(status, next).catch(() => undefined);
                      }}
                    >
                      Down
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        void remove(status.id).catch(() => undefined);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <span className="text-sm text-slate-100">{status.name}</span>
                  <span className="text-xs text-slate-500">
                    {status.category}
                  </span>
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
            id="new-status-name"
            label="New status"
            className="w-40"
            value={name}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <div className="w-40">
            <label
              htmlFor="new-status-category"
              className="block text-sm font-medium text-slate-200"
            >
              Category
            </label>
            <Select
              id="new-status-category"
              value={category}
              onChange={(event) => {
                setCategory(event.target.value as StatusCategory);
              }}
            >
              {CATEGORIES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" disabled={!canSubmit}>
            {isMutating ? 'Adding' : 'Add status'}
          </Button>
          {addError !== null && (
            <ErrorAlert
              message={errorMessage(addError, 'Could not add that status.')}
            />
          )}
        </form>
      )}
    </section>
  );
};

export default StatusesSection;
