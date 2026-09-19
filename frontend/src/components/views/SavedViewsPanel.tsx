/**
 * The saved views a person may apply, rename and delete. A view stores a
 * filter rather than a result set, so applying one hands its filter back to
 * the page, which runs the ordinary issue list with it; nothing here reads
 * issues, because a second read path would be a second place project
 * visibility is decided.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { createView, deleteView, listViews, updateView } from '../../api/views';
import { m3ErrorMessage } from '../../lib/errors';
import { viewsKey } from '../../lib/queryKeys';
import type {
  SavedViewRead,
  ViewFilter,
  ViewKind,
  ViewListScope,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Field from '../ui/field';
import Spinner from '../ui/spinner';
import { SelectField } from '../ui/select';

/** Props for SavedViewsPanel: where the views live and what applying one does. */
export interface SavedViewsPanelProps {
  workspaceId: string;
  /** The project a project-scoped view belongs to, or empty for personal only. */
  projectId: string;
  /** The filter the page is showing now, which "Save this view" stores. */
  currentFilter: ViewFilter;
  /** Whether the page is a list or a board, stored as the view's kind. */
  currentKind: ViewKind;
  /** Hands a stored filter back to the page, which re-runs its own list. */
  onApply: (view: SavedViewRead) => void;
}

/** How often the view list is re-read. */
const POLL_MS = 60000;

/** Lists, creates, renames, deletes and applies saved views. */
export const SavedViewsPanel: React.FC<SavedViewsPanelProps> = ({
  workspaceId,
  projectId,
  currentFilter,
  currentKind,
  onApply,
}) => {
  const auth = useQueryAuth();
  const [scope, setScope] = useState<ViewListScope>('mine');
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState('');

  const queryKey = viewsKey(workspaceId, scope, projectId);
  const enabled = workspaceId !== '';

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) =>
      listViews(
        workspaceId,
        {
          scope,
          ...(projectId === '' ? {} : { project_id: projectId }),
        },
        signal
      ),
    { intervalMs: POLL_MS, enabled, queryKey, auth }
  );

  const {
    mutate: save,
    isMutating: isSaving,
    error: saveError,
  } = useMutationWithRefetch(
    (viewName: string, asProject: boolean) =>
      createView(workspaceId, {
        name: viewName,
        kind: currentKind,
        filter: currentFilter,
        ...(asProject && projectId !== '' ? { project_id: projectId } : {}),
      }),
    queryKey
  );

  const { mutate: rename, error: renameError } = useMutationWithRefetch(
    (viewId: string, viewName: string) =>
      updateView(workspaceId, viewId, { name: viewName }),
    queryKey
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    (viewId: string) => deleteView(workspaceId, viewId),
    queryKey
  );

  const views = data ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h3 className="text-base font-medium text-white">Saved views</h3>
        <SelectField
          id="views-scope"
          label="Show"
          className="w-40"
          value={scope}
          onChange={(event) => {
            setScope(event.target.value as ViewListScope);
          }}
        >
          <option value="mine">Mine</option>
          <option value="project">This project</option>
          <option value="all">All</option>
        </SelectField>
      </div>

      {error !== null && (
        <ErrorAlert
          message={m3ErrorMessage(error, 'Could not load the saved views.')}
        />
      )}
      {saveError !== null && (
        <ErrorAlert
          message={m3ErrorMessage(saveError, 'Could not save that view.')}
        />
      )}
      {renameError !== null && (
        <ErrorAlert
          message={m3ErrorMessage(renameError, 'Could not rename that view.')}
        />
      )}
      {removeError !== null && (
        <ErrorAlert
          message={m3ErrorMessage(removeError, 'Could not delete that view.')}
        />
      )}

      {isLoading ? (
        <Spinner label="Loading saved views" />
      ) : views.length === 0 ? (
        <p className="text-sm text-slate-400">No saved views yet.</p>
      ) : (
        <ul className="space-y-2">
          {views.map((view) => (
            <li
              key={view.view_id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-slate-700 px-3 py-2"
            >
              {renaming === view.view_id ? (
                <>
                  <Field
                    id={`rename-${view.view_id}`}
                    label="New name"
                    className="w-56"
                    value={renameTo}
                    onChange={(event) => {
                      setRenameTo(event.target.value);
                    }}
                  />
                  <Button
                    disabled={renameTo.trim() === ''}
                    onClick={() => {
                      void rename(view.view_id, renameTo.trim())
                        .then(() => {
                          setRenaming(null);
                        })
                        .catch(() => undefined);
                    }}
                  >
                    Save
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setRenaming(null);
                    }}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="text-sm text-sky-400 hover:text-sky-300"
                    onClick={() => {
                      onApply(view);
                    }}
                  >
                    {view.name}
                  </button>
                  <span className="text-xs text-slate-500">
                    {view.scope === 'project' ? 'Project' : 'Personal'} ·{' '}
                    {view.kind === 'board' ? 'Board' : 'List'}
                  </span>
                  <Button
                    variant="secondary"
                    className="ml-auto"
                    aria-label={`Rename ${view.name}`}
                    onClick={() => {
                      setRenameTo(view.name);
                      setRenaming(view.view_id);
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="secondary"
                    aria-label={`Delete ${view.name}`}
                    onClick={() => {
                      void remove(view.view_id).catch(() => undefined);
                    }}
                  >
                    Delete
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-3 rounded-md border border-slate-700 p-4">
        <Field
          id="new-view-name"
          label="Save this view"
          className="w-56"
          placeholder="Name it"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        {projectId !== '' && (
          <label className="flex items-center gap-2 pb-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={shared}
              onChange={(event) => {
                setShared(event.target.checked);
              }}
            />
            Share with the project
          </label>
        )}
        <Button
          disabled={isSaving || name.trim() === ''}
          onClick={() => {
            void save(name.trim(), shared)
              .then(() => {
                setName('');
                setShared(false);
              })
              .catch(() => undefined);
          }}
        >
          {isSaving ? 'Saving' : 'Save view'}
        </Button>
      </div>
    </section>
  );
};

export default SavedViewsPanel;
