/**
 * The project statuses of one scope, grouped by the six fixed categories: the
 * workspace's in workspace settings, or one team's own in that team's
 * settings. Each scope edits only its own rows. The workspace's first status
 * in a category is its default, and every category keeps at least one
 * workspace status; a team's statuses sit after the workspace's, are never a
 * default, and a deleted one moves its projects to the workspace default or a
 * status picked in its place. Team settings show the workspace's statuses as
 * read only, and workspace settings mark the statuses each team keeps.
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
import { useProjectStatuses } from '../../hooks/useProjectStatuses';
import { errorMessage } from '../../lib/errors';
import {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
} from '../../lib/planningDisplay';
import { isWorkspaceEntry } from '../../lib/projectScopes';
import { orderProjectStatuses } from '../../lib/projectStatuses';
import { STATUS_COLOR_VALUES } from '../../lib/statusAppearance';
import type {
  ProjectStatus,
  ProjectStatusCreate,
  ProjectStatusRead,
  ProjectStatusUpdate,
  TeamRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import { Badge } from '../ui/badge';
import Button, { IconButton } from '../ui/button';
import Dialog from '../ui/dialog';
import Field from '../ui/field';
import Menu, { MenuItem } from '../ui/menu';
import { SelectField } from '../ui/select';
import { SkeletonRows } from '../ui/skeleton';
import LabelColorPicker from '../workflow/LabelColorPicker';
import ProjectStatusGlyph from './ProjectStatusGlyph';

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

/** Props for ProjectStatusesEditor. */
export interface ProjectStatusesEditorProps {
  workspaceId: string;
  /** The team whose own statuses are edited, or null for the workspace's. */
  teamId: string | null;
  /** Whether the caller changes this scope: a workspace admin, or a team admin for a team. */
  canEdit: boolean;
  /** The workspace's teams, to name the team that keeps a status. */
  teams?: readonly TeamRead[];
}

/** Lists and edits the project statuses of one scope, grouped by category. */
const ProjectStatusesEditor: React.FC<ProjectStatusesEditorProps> = ({
  workspaceId,
  teamId,
  canEdit,
  teams = [],
}) => {
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

  const teamNames = new Map(teams.map((team) => [team.id, team.name]));
  const ordered = orderProjectStatuses(statuses);
  const isOwn = (status: ProjectStatusRead): boolean =>
    teamId === null ? isWorkspaceEntry(status) : status.team_id === teamId;
  const workspaceIn = (category: ProjectStatus): ProjectStatusRead[] =>
    ordered.filter(
      (status) => status.category === category && isWorkspaceEntry(status)
    );
  const ownIn = (category: ProjectStatus): ProjectStatusRead[] =>
    ordered.filter((status) => status.category === category && isOwn(status));
  const othersIn = (category: ProjectStatus): ProjectStatusRead[] =>
    ordered.filter(
      (status) =>
        status.category === category &&
        !isOwn(status) &&
        (teamId === null || isWorkspaceEntry(status))
    );

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
    const body: ProjectStatusCreate = {
      name: name.trim(),
      category: adding,
      color,
    };
    if (teamId !== null) body.team_id = teamId;
    void create(body)
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

  const replacementsFor = (status: ProjectStatusRead): ProjectStatusRead[] =>
    isWorkspaceEntry(status)
      ? workspaceIn(status.category).filter((row) => row.id !== status.id)
      : ordered.filter(
          (row) =>
            row.id !== status.id &&
            row.category === status.category &&
            (isWorkspaceEntry(row) || row.team_id === status.team_id)
        );

  const askDelete = (status: ProjectStatusRead): void => {
    const options = replacementsFor(status);
    const replacement = options.find((row) => row.is_default) ?? options[0];
    if (replacement === undefined) return;
    setDeleting({ status, replacementId: replacement.id });
  };

  const rowClass =
    'flex min-h-row flex-wrap items-center gap-3 border-b border-line py-1 pl-3 pr-3 transition-colors duration-100 last:border-b-0 hover:bg-surface';

  const renderReadOnly = (status: ProjectStatusRead): React.ReactNode => {
    const owner =
      status.team_id === undefined || status.team_id === null
        ? null
        : (teamNames.get(status.team_id) ?? 'Team');
    return (
      <li key={status.id} className={rowClass}>
        <span className="flex items-center gap-2 text-sm text-text">
          <ProjectStatusGlyph status={status.category} color={status.color} />
          {status.name}
        </span>
        {status.is_default && <Badge>Default</Badge>}
        {teamId !== null && owner === null && (
          <Badge tone="neutral">Workspace</Badge>
        )}
        {owner !== null && <Badge tone="neutral">{owner}</Badge>}
        <span className="text-xs text-text-muted">
          {countText(status.project_count)}
        </span>
      </li>
    );
  };

  const renderRow = (
    status: ProjectStatusRead,
    index: number,
    siblings: ProjectStatusRead[]
  ): React.ReactNode => {
    if (!canEdit) return renderReadOnly(status);
    const isLast =
      isWorkspaceEntry(status) && workspaceIn(status.category).length === 1;
    return (
      <li key={status.id} className={rowClass}>
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
        {status.is_default && <Badge>Default</Badge>}
        <span className="text-xs text-text-muted">
          {countText(status.project_count)}
        </span>
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
              disabled={isLast}
              textValue="Delete"
              onSelect={() => {
                askDelete(status);
              }}
            >
              <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
              {isLast ? 'Delete (last in its category)' : 'Delete'}
            </MenuItem>
          </Menu>
        </div>
      </li>
    );
  };

  const renderCategory = (category: ProjectStatus): React.ReactNode => {
    const own = ownIn(category);
    const others = othersIn(category);
    const label = PROJECT_STATUS_LABELS[category];
    const before = teamId === null ? [] : others;
    const after = teamId === null ? others : [];
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
          {before.map(renderReadOnly)}
          {own.map((status, index) => renderRow(status, index, own))}
          {after.map(renderReadOnly)}
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
              id={`new-project-status-${teamId ?? 'workspace'}-${category}`}
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
    deleting === null ? [] : replacementsFor(deleting.status);

  return (
    <div className="space-y-4">
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the project statuses.')}
        />
      )}
      {writeError !== null && <ErrorAlert message={writeError} />}

      {isLoading && statuses.length === 0 ? (
        <SkeletonRows count={6} label="Loading project statuses" />
      ) : (
        <div className="space-y-3">{PROJECT_STATUSES.map(renderCategory)}</div>
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
            id={`project-status-replacement-${teamId ?? 'workspace'}`}
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
  );
};

export default ProjectStatusesEditor;
