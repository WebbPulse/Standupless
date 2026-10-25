/**
 * The Project statuses page of workspace settings: the workspace's own project
 * stages, each inside one of the six fixed categories that progress, rollups
 * and closing key off. Any member reads them with how many projects sit in
 * each; a workspace owner or admin adds, renames, recolors, reorders and
 * deletes them. A deleted status moves its projects onto another status in the
 * same category, and every category keeps at least one. The first status of a
 * category is its default, where a project set to only the category lands.
 */

import React, { useState } from 'react';
import {
  LuArrowDown,
  LuArrowUp,
  LuEllipsis,
  LuPlus,
  LuTrash2,
} from 'react-icons/lu';
import { useMutationWithRefetch } from '@webbpulse/api-client/react';
import {
  createProjectStatus,
  deleteProjectStatus,
  updateProjectStatus,
} from '../../api/projectStatuses';
import ProjectStatusGlyph from '../../components/planning/ProjectStatusGlyph';
import { ErrorAlert } from '../../components/ui/alert';
import { Badge } from '../../components/ui/badge';
import Button, { IconButton } from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import Field from '../../components/ui/field';
import Menu, { MenuItem } from '../../components/ui/menu';
import { SelectField } from '../../components/ui/select';
import { SkeletonRows } from '../../components/ui/skeleton';
import LabelColorPicker from '../../components/workflow/LabelColorPicker';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useProjectStatuses } from '../../hooks/useProjectStatuses';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
} from '../../lib/planningDisplay';
import { orderProjectStatuses } from '../../lib/projectStatuses';
import { STATUS_COLOR_VALUES } from '../../lib/statusAppearance';
import type {
  ProjectStatus,
  ProjectStatusCreate,
  ProjectStatusRead,
  ProjectStatusUpdate,
} from '../../types/Api';

/** The swatch a status without its own color shows, after its category's tone. */
const CATEGORY_COLORS: Record<ProjectStatus, string> = {
  backlog: STATUS_COLOR_VALUES.gray,
  planned: STATUS_COLOR_VALUES.gray,
  in_progress: STATUS_COLOR_VALUES.amber,
  paused: STATUS_COLOR_VALUES.gray,
  completed: STATUS_COLOR_VALUES.green,
  canceled: STATUS_COLOR_VALUES.gray,
};

/** What each category means, under its heading. */
const CATEGORY_HINTS: Record<ProjectStatus, string> = {
  backlog: 'Ideas and projects nobody has committed to yet.',
  planned: 'Committed projects that have not started.',
  in_progress: 'Projects under way, which count as active.',
  paused: 'Projects on hold, kept open.',
  completed: 'Finished projects, which close and stamp a completion date.',
  canceled: 'Projects dropped before they finished, which close too.',
};

/** How a status's project count reads. */
const countText = (count: number): string =>
  count === 1 ? '1 project' : `${String(count)} projects`;

/** A status about to be deleted and the one its projects move to. */
interface Deleting {
  status: ProjectStatusRead;
  replacementId: string;
}

/** Lists and edits the workspace's project statuses, grouped by category. */
const ProjectStatusesSettings: React.FC = () => {
  const { workspace } = useWorkspace();
  const workspaceId = workspace?.id ?? '';
  const canEdit = canManageMembers(workspace?.role);
  const { statuses, error, isLoading, queryKey } =
    useProjectStatuses(workspaceId);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [adding, setAdding] = useState<ProjectStatus | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState(STATUS_COLOR_VALUES.blue);
  const [isAdding, setIsAdding] = useState(false);
  const [deleting, setDeleting] = useState<Deleting | null>(null);

  const { mutate: create } = useMutationWithRefetch(
    (body: ProjectStatusCreate) => createProjectStatus(workspaceId, body),
    [queryKey]
  );
  const { mutate: update } = useMutationWithRefetch(
    (status: ProjectStatusRead, body: ProjectStatusUpdate) =>
      updateProjectStatus(workspaceId, status.id, body),
    [queryKey]
  );
  const { mutate: remove } = useMutationWithRefetch(
    (status: ProjectStatusRead, replacementId: string) =>
      deleteProjectStatus(workspaceId, status.id, replacementId),
    [queryKey]
  );

  const ordered = orderProjectStatuses(statuses);
  const inCategory = (category: ProjectStatus): ProjectStatusRead[] =>
    ordered.filter((status) => status.category === category);

  const run = (write: Promise<unknown>, fallback: string): void => {
    setWriteError(null);
    void write.catch((cause: unknown) => {
      setWriteError(errorMessage(cause, fallback));
    });
  };

  const startAdding = (category: ProjectStatus): void => {
    setAdding(category);
    setName('');
    setColor(CATEGORY_COLORS[category]);
  };

  const onAdd = (event: React.FormEvent): void => {
    event.preventDefault();
    if (adding === null || name.trim() === '' || isAdding) return;
    setWriteError(null);
    setIsAdding(true);
    void create({ name: name.trim(), category: adding, color })
      .then(() => {
        setAdding(null);
        setName('');
      })
      .catch((cause: unknown) => {
        setWriteError(errorMessage(cause, 'Could not add that status.'));
      })
      .finally(() => {
        setIsAdding(false);
      });
  };

  const onRename = (status: ProjectStatusRead, value: string): void => {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === status.name) return;
    run(update(status, { name: trimmed }), 'Could not rename that status.');
  };

  const move = (status: ProjectStatusRead, position: number): void => {
    run(update(status, { position }), 'Could not move that status.');
  };

  const askDelete = (status: ProjectStatusRead): void => {
    const replacement = inCategory(status.category).find(
      (row) => row.id !== status.id
    );
    if (replacement === undefined) return;
    setDeleting({ status, replacementId: replacement.id });
  };

  const renderRow = (
    status: ProjectStatusRead,
    index: number,
    siblings: ProjectStatusRead[]
  ): React.ReactNode => {
    const isOnly = siblings.length === 1;
    return (
      <li
        key={status.id}
        className="flex min-h-row flex-wrap items-center gap-3 border-b border-line py-1 pl-3 pr-3 transition-colors duration-100 last:border-b-0 hover:bg-surface"
      >
        {canEdit ? (
          <>
            <LabelColorPicker
              name={status.name}
              value={status.color ?? CATEGORY_COLORS[status.category]}
              onChange={(next) => {
                if (next === status.color) return;
                run(
                  update(status, { color: next }),
                  'Could not recolor that status.'
                );
              }}
            />
            <Field
              key={`${status.id}-${status.name}`}
              id={`project-status-name-${status.id}`}
              label={`Name of ${status.name}`}
              hideLabel
              className="w-48"
              defaultValue={status.name}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              onBlur={(event) => {
                onRename(status, event.target.value);
              }}
            />
          </>
        ) : (
          <span className="flex items-center gap-2 text-sm text-text">
            <ProjectStatusGlyph status={status.category} color={status.color} />
            {status.name}
          </span>
        )}
        {index === 0 && <Badge>Default</Badge>}
        <span className="text-xs text-text-muted">
          {countText(status.project_count)}
        </span>
        {canEdit && (
          <div className="ml-auto">
            <Menu
              label={`${status.name} actions`}
              align="end"
              trigger={(props) => (
                <IconButton
                  label={`Actions for ${status.name}`}
                  size="sm"
                  {...props}
                >
                  <LuEllipsis className="h-3.5 w-3.5" />
                </IconButton>
              )}
            >
              <MenuItem
                disabled={index === 0}
                onSelect={() => {
                  move(status, index - 1);
                }}
              >
                <LuArrowUp aria-hidden="true" className="h-3.5 w-3.5" />
                Move up
              </MenuItem>
              <MenuItem
                disabled={index === siblings.length - 1}
                onSelect={() => {
                  move(status, index + 1);
                }}
              >
                <LuArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
                Move down
              </MenuItem>
              <MenuItem
                danger
                disabled={isOnly}
                textValue="Delete"
                onSelect={() => {
                  askDelete(status);
                }}
              >
                <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
                {isOnly ? 'Delete (last in its category)' : 'Delete'}
              </MenuItem>
            </Menu>
          </div>
        )}
      </li>
    );
  };

  const renderCategory = (category: ProjectStatus): React.ReactNode => {
    const siblings = inCategory(category);
    const label = PROJECT_STATUS_LABELS[category];
    return (
      <section
        key={category}
        aria-label={label}
        className="rounded-md border border-line"
      >
        <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2">
          <ProjectStatusGlyph status={category} />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-text">{label}</h3>
            <p className="text-xs text-text-muted">
              {CATEGORY_HINTS[category]}
            </p>
          </div>
          {canEdit && (
            <IconButton
              label={`Add a ${label.toLowerCase()} status`}
              size="sm"
              onClick={() => {
                startAdding(category);
              }}
            >
              <LuPlus className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </div>
        <ul>
          {siblings.map((status, index) => renderRow(status, index, siblings))}
        </ul>
        {canEdit && adding === category && (
          <form
            aria-label={`Add a ${label.toLowerCase()} status`}
            className="flex flex-wrap items-center gap-3 border-t border-line px-3 py-2"
            onSubmit={onAdd}
          >
            <LabelColorPicker
              name={name.trim()}
              value={color}
              onChange={setColor}
            />
            <Field
              id={`new-project-status-${category}`}
              label={`New ${label.toLowerCase()} status`}
              hideLabel
              placeholder="Status name"
              className="w-48"
              value={name}
              autoComplete="off"
              autoFocus
              onChange={(event) => {
                setName(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setAdding(null);
              }}
            />
            <div className="ml-auto flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAdding(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={name.trim() === '' || isAdding}
              >
                {isAdding ? 'Adding' : 'Add status'}
              </Button>
            </div>
          </form>
        )}
      </section>
    );
  };

  const replacements =
    deleting === null
      ? []
      : inCategory(deleting.status.category).filter(
          (row) => row.id !== deleting.status.id
        );

  return (
    <WorkspaceShell
      title="Settings"
      toolbar={
        workspace === null ? undefined : <SettingsNav workspace={workspace} />
      }
    >
      <div className="max-w-2xl space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Project statuses</h2>
          <p className="text-sm text-text-muted">
            The stages a project moves through, shared by every team. Each
            status sits in a fixed category, which decides whether a project
            counts as active or closed. The first status in a category is its
            default. Only a workspace admin changes them here.
          </p>
        </div>

        {error !== null && (
          <ErrorAlert
            message={errorMessage(
              error,
              'Could not load the project statuses.'
            )}
          />
        )}
        {writeError !== null && <ErrorAlert message={writeError} />}

        {isLoading && statuses.length === 0 ? (
          <SkeletonRows count={6} label="Loading project statuses" />
        ) : (
          <div className="space-y-3">
            {PROJECT_STATUSES.map(renderCategory)}
          </div>
        )}

        <Dialog
          open={deleting !== null}
          onClose={() => {
            setDeleting(null);
          }}
          title={`Delete ${deleting?.status.name ?? 'status'}?`}
          description={
            deleting === null || deleting.status.project_count === 0
              ? 'No projects sit in this status.'
              : `${countText(deleting.status.project_count)} will move to the status you pick.`
          }
          size="sm"
        >
          <div className="space-y-4">
            <SelectField
              id="project-status-replacement"
              label="Move projects to"
              value={deleting?.replacementId ?? ''}
              onChange={(event) => {
                const replacementId = event.target.value;
                setDeleting((current) =>
                  current === null ? null : { ...current, replacementId }
                );
              }}
            >
              {replacements.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </SelectField>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setDeleting(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => {
                  const target = deleting;
                  setDeleting(null);
                  if (target !== null) {
                    run(
                      remove(target.status, target.replacementId),
                      'Could not delete that status.'
                    );
                  }
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        </Dialog>
      </div>
    </WorkspaceShell>
  );
};

export default ProjectStatusesSettings;
