/**
 * The saved views a person may apply, rename and delete, as a rail beside the
 * page. A view stores a filter rather than a result set, so applying one hands
 * its filter back to the page, which runs the ordinary issue list with it;
 * nothing here reads issues, because a second read path would be a second
 * place project visibility is decided.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { LuBookmark, LuPencil, LuTrash2 } from 'react-icons/lu';
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
import Button, { IconButton } from '../ui/button';
import Checkbox from '../ui/checkbox';
import EmptyState from '../ui/empty-state';
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

/** Names a view's scope and kind in two words, for the meta beside its name. */
const describeView = (view: SavedViewRead): string =>
  `${view.scope === 'project' ? 'Project' : 'Personal'} ${
    view.kind === 'board' ? 'board' : 'list'
  }`;

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
    <aside
      aria-label="Saved views"
      className="flex w-full shrink-0 flex-col border-t border-line lg:w-rail lg:border-t-0 lg:border-l"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 px-4">
        <h2 className="text-sm font-semibold text-text">Saved views</h2>
        <SelectField
          id="views-scope"
          label="Show"
          hideLabel
          className="ml-auto w-32"
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

      {(error !== null ||
        saveError !== null ||
        renameError !== null ||
        removeError !== null) && (
        <div className="space-y-2 px-4 pb-2">
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
              message={m3ErrorMessage(
                renameError,
                'Could not rename that view.'
              )}
            />
          )}
          {removeError !== null && (
            <ErrorAlert
              message={m3ErrorMessage(
                removeError,
                'Could not delete that view.'
              )}
            />
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 lg:overflow-y-auto">
        {isLoading ? (
          <Spinner label="Loading saved views" />
        ) : views.length === 0 ? (
          <EmptyState
            icon={<LuBookmark />}
            message="No saved views yet."
            className="py-8"
          />
        ) : (
          <ul className="px-2 py-1">
            {views.map((view) => (
              <li
                key={view.view_id}
                className="flex min-h-7 items-center gap-1 rounded-sm px-2 transition-colors duration-100 hover:bg-surface"
              >
                {renaming === view.view_id ? (
                  <form
                    className="flex w-full items-center gap-1 py-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (renameTo.trim() === '') return;
                      void rename(view.view_id, renameTo.trim())
                        .then(() => {
                          setRenaming(null);
                        })
                        .catch(() => undefined);
                    }}
                  >
                    <Field
                      id={`rename-${view.view_id}`}
                      label="New name"
                      hideLabel
                      className="min-w-0 flex-1"
                      value={renameTo}
                      autoFocus
                      onChange={(event) => {
                        setRenameTo(event.target.value);
                      }}
                    />
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      disabled={renameTo.trim() === ''}
                    >
                      Save
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setRenaming(null);
                      }}
                    >
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate rounded-xs py-1 text-left text-sm font-medium text-text"
                      onClick={() => {
                        onApply(view);
                      }}
                    >
                      {view.name}
                    </button>
                    <span className="shrink-0 text-2xs text-text-faint">
                      {describeView(view)}
                    </span>
                    <IconButton
                      label={`Rename ${view.name}`}
                      size="sm"
                      onClick={() => {
                        setRenameTo(view.name);
                        setRenaming(view.view_id);
                      }}
                    >
                      <LuPencil />
                    </IconButton>
                    <IconButton
                      label={`Delete ${view.name}`}
                      size="sm"
                      onClick={() => {
                        void remove(view.view_id).catch(() => undefined);
                      }}
                    >
                      <LuTrash2 />
                    </IconButton>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <form
        className="shrink-0 space-y-2 border-t border-line px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (isSaving || name.trim() === '') return;
          void save(name.trim(), shared)
            .then(() => {
              setName('');
              setShared(false);
            })
            .catch(() => undefined);
        }}
      >
        <div className="flex items-center gap-2">
          <Field
            id="new-view-name"
            label="Save this view"
            hideLabel
            className="min-w-0 flex-1"
            placeholder="Name this view"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={isSaving || name.trim() === ''}
          >
            {isSaving ? 'Saving' : 'Save view'}
          </Button>
        </div>
        {projectId !== '' && (
          <Checkbox
            label="Share with the project"
            checked={shared}
            onChange={(event) => {
              setShared(event.target.checked);
            }}
          />
        )}
      </form>
    </aside>
  );
};

export default SavedViewsPanel;
