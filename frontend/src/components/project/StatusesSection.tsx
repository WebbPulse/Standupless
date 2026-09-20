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
import { StatusGlyph } from '../ui/glyphs';
import { SelectField } from '../ui/select';
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

/** How a category reads beside a status. */
const categoryLabel = (category: StatusCategory): string =>
  CATEGORIES.find((item) => item.value === category)?.label ?? category;

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
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Statuses</h3>
        <p className="text-sm text-text-muted">
          The workflow an issue moves through, in the order shown here. Every
          category keeps at least one status.
        </p>
      </div>

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
        <p className="text-sm text-text-muted">This project has no statuses.</p>
      ) : (
        <ul className="rounded-md border border-line">
          {statuses.map((status, index) => (
            <li
              key={status.id}
              className="flex min-h-row flex-wrap items-center gap-3 border-b border-line px-3 py-1 transition-colors duration-100 last:border-b-0 hover:bg-surface"
            >
              <StatusGlyph category={status.category} />
              {canEdit ? (
                <>
                  <Field
                    id={`status-name-${status.id}`}
                    label="Name"
                    hideLabel
                    className="w-40"
                    defaultValue={status.name}
                    onBlur={(event) => {
                      onRename(status, event.target.value);
                    }}
                  />
                  <SelectField
                    id={`status-category-${status.id}`}
                    label="Category"
                    hideLabel
                    className="w-32"
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
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
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
                      variant="ghost"
                      size="sm"
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
                      variant="ghost"
                      size="sm"
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
                  <span className="font-medium text-text">{status.name}</span>
                  <span className="text-xs text-text-muted">
                    {categoryLabel(status.category)}
                  </span>
                </>
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
          <h4 className="text-sm font-medium">Add a status</h4>
          {addError !== null && (
            <ErrorAlert
              message={errorMessage(addError, 'Could not add that status.')}
            />
          )}
          <div className="flex flex-wrap items-end gap-3">
            <Field
              id="new-status-name"
              label="New status"
              className="w-48"
              value={name}
              autoComplete="off"
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            <SelectField
              id="new-status-category"
              label="Category"
              className="w-36"
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
            </SelectField>
            <Button type="submit" variant="primary" disabled={!canSubmit}>
              {isMutating ? 'Adding' : 'Add status'}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
};

export default StatusesSection;
