/**
 * The project label list of one scope: the workspace's labels in workspace
 * settings, or one team's own labels in that team's settings. Each scope edits
 * only its own rows. Team settings show the workspace's labels beside the
 * team's as read only, since every project on the team is offered both, and
 * workspace settings name the teams that keep labels of their own, as Linear
 * lists a team's project labels apart from the workspace's.
 */

import React, { useState } from 'react';
import { LuEllipsis } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { useMutationWithRefetch } from '@webbpulse/api-client/react';
import {
  createProjectLabel,
  deleteProjectLabel,
  updateProjectLabel,
} from '../../api/projectLabels';
import { useProjectLabels } from '../../hooks/useProjectLabels';
import { errorMessage } from '../../lib/errors';
import { isWorkspaceEntry } from '../../lib/projectScopes';
import { STATUS_COLOR_VALUES } from '../../lib/statusAppearance';
import type {
  ProjectLabelCreate,
  ProjectLabelRead,
  ProjectLabelUpdate,
  TeamRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import { Badge, LabelChip } from '../ui/badge';
import Button, { IconButton } from '../ui/button';
import Field from '../ui/field';
import Menu, { MenuItem } from '../ui/menu';
import { SkeletonRows } from '../ui/skeleton';
import { ConfirmDeleteDialog } from '../workflow/InheritedControls';
import LabelColorPicker from '../workflow/LabelColorPicker';

/** The color a new project label starts on. */
const DEFAULT_COLOR = STATUS_COLOR_VALUES.blue;

/** How a label's project count reads. */
const countText = (count: number): string =>
  count === 1 ? '1 project' : `${String(count)} projects`;

/** Props for ProjectLabelsEditor. */
export interface ProjectLabelsEditorProps {
  workspaceId: string;
  /** The team whose own labels are edited, or null for the workspace's. */
  teamId: string | null;
  /** Whether the caller changes this scope: a workspace admin, or a team admin for a team. */
  canEdit: boolean;
  /** The workspace's teams, to name the teams that keep their own labels. */
  teams?: readonly TeamRead[];
  /** The settings page of a team, for the link beside its own labels. */
  teamSettingsPath?: (team: TeamRead) => string;
}

/** Lists and edits the project labels of one scope. */
const ProjectLabelsEditor: React.FC<ProjectLabelsEditorProps> = ({
  workspaceId,
  teamId,
  canEdit,
  teams = [],
  teamSettingsPath,
}) => {
  const { labels, error, isLoading, queryKey } = useProjectLabels(workspaceId);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [isAdding, setIsAdding] = useState(false);
  const [deleting, setDeleting] = useState<ProjectLabelRead | null>(null);

  const own = labels.filter((label) =>
    teamId === null ? isWorkspaceEntry(label) : label.team_id === teamId
  );
  const inherited =
    teamId === null ? [] : labels.filter((label) => isWorkspaceEntry(label));
  const teamGroups =
    teamId === null
      ? teams
          .map((team) => ({
            team,
            rows: labels.filter((label) => label.team_id === team.id),
          }))
          .filter((group) => group.rows.length > 0)
      : [];

  const { mutate: create } = useMutationWithRefetch(
    (body: ProjectLabelCreate) => createProjectLabel(workspaceId, body),
    [queryKey]
  );
  const { mutate: update } = useMutationWithRefetch(
    (label: ProjectLabelRead, body: ProjectLabelUpdate) =>
      updateProjectLabel(workspaceId, label.id, body),
    [queryKey]
  );
  const { mutate: remove } = useMutationWithRefetch(
    (label: ProjectLabelRead) => deleteProjectLabel(workspaceId, label.id),
    [queryKey]
  );

  const run = (write: Promise<unknown>, fallback: string): void => {
    setWriteError(null);
    void write.catch((cause: unknown) => {
      setWriteError(errorMessage(cause, fallback));
    });
  };

  const onAdd = (event: React.FormEvent): void => {
    event.preventDefault();
    if (name.trim() === '' || isAdding) return;
    setWriteError(null);
    setIsAdding(true);
    const body: ProjectLabelCreate = { name: name.trim(), color };
    if (teamId !== null) body.team_id = teamId;
    void create(body)
      .then(() => {
        setName('');
        setColor(DEFAULT_COLOR);
      })
      .catch((cause: unknown) => {
        setWriteError(errorMessage(cause, 'Could not add that label.'));
      })
      .finally(() => {
        setIsAdding(false);
      });
  };

  const onRename = (label: ProjectLabelRead, value: string): void => {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === label.name) return;
    run(update(label, { name: trimmed }), 'Could not rename that label.');
  };

  const rowClass =
    'flex min-h-row flex-wrap items-center gap-3 border-b border-line py-1 pl-3 pr-3 transition-colors duration-100 last:border-b-0 hover:bg-surface';

  const renderReadOnly = (
    label: ProjectLabelRead,
    marker: React.ReactNode
  ): React.ReactNode => (
    <li key={label.id} className={rowClass}>
      <LabelChip color={label.color} name={label.name} />
      {marker}
      <span className="text-xs text-text-muted">
        {countText(label.project_count)}
      </span>
    </li>
  );

  const renderRow = (label: ProjectLabelRead): React.ReactNode => {
    if (!canEdit) return renderReadOnly(label, null);
    return (
      <li key={label.id} className={rowClass}>
        <LabelColorPicker
          name={label.name}
          value={label.color}
          onChange={(next) => {
            if (next === label.color) return;
            run(
              update(label, { color: next }),
              'Could not recolor that label.'
            );
          }}
        />
        <Field
          key={`${label.id}-${label.name}`}
          id={`project-label-name-${label.id}`}
          label={`Name of ${label.name}`}
          hideLabel
          className="w-48"
          defaultValue={label.name}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          onBlur={(event) => {
            onRename(label, event.target.value);
          }}
        />
        <span className="text-xs text-text-muted">
          {countText(label.project_count)}
        </span>
        <div className="ml-auto">
          <Menu
            label={`${label.name} actions`}
            align="end"
            trigger={(props) => (
              <IconButton
                label={`Actions for ${label.name}`}
                size="sm"
                {...props}
              >
                <LuEllipsis className="h-3.5 w-3.5" />
              </IconButton>
            )}
          >
            <MenuItem
              danger
              onSelect={() => {
                setDeleting(label);
              }}
            >
              Delete
            </MenuItem>
          </Menu>
        </div>
      </li>
    );
  };

  const loading = isLoading && labels.length === 0;

  return (
    <div className="space-y-4">
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the project labels.')}
        />
      )}
      {writeError !== null && <ErrorAlert message={writeError} />}

      {canEdit && (
        <form
          aria-label="Add a project label"
          className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2"
          onSubmit={onAdd}
        >
          <LabelColorPicker
            name={name.trim()}
            value={color}
            onChange={setColor}
          />
          <Field
            id={`new-project-label-${teamId ?? 'workspace'}`}
            label="New project label"
            hideLabel
            placeholder="Label name"
            className="w-48"
            value={name}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            className="ml-auto"
            disabled={name.trim() === '' || isAdding}
          >
            {isAdding ? 'Adding' : 'Add label'}
          </Button>
        </form>
      )}

      {loading ? (
        <SkeletonRows count={4} label="Loading project labels" />
      ) : own.length === 0 ? (
        <p className="text-sm text-text-muted">
          {teamId === null
            ? 'No project labels yet.'
            : 'This team has no project labels of its own.'}
        </p>
      ) : (
        <ul
          aria-label={teamId === null ? 'Workspace labels' : 'Team labels'}
          className="rounded-md border border-line"
        >
          {own.map(renderRow)}
        </ul>
      )}

      {!loading && inherited.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-text">From the workspace</h4>
          <ul
            aria-label="Workspace labels"
            className="rounded-md border border-line"
          >
            {inherited.map((label) =>
              renderReadOnly(label, <Badge tone="neutral">Workspace</Badge>)
            )}
          </ul>
        </div>
      )}

      {!loading && teamGroups.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-text">Team labels</h4>
          <p className="text-xs text-text-muted">
            These teams keep labels of their own, offered only to their
            projects. Their team admins change them in team settings.
          </p>
          <ul
            aria-label="Team labels"
            className="rounded-md border border-line"
          >
            {teamGroups.map(({ team, rows }) => (
              <li key={team.id} className={rowClass}>
                <span className="w-32 truncate text-sm text-text">
                  {teamSettingsPath === undefined ? (
                    team.name
                  ) : (
                    <Link
                      to={`${teamSettingsPath(team)}#team-settings-projects`}
                      className="hover:underline"
                    >
                      {team.name}
                    </Link>
                  )}
                </span>
                <span className="flex min-w-0 flex-wrap gap-1">
                  {rows.map((label) => (
                    <LabelChip
                      key={label.id}
                      color={label.color}
                      name={label.name}
                    />
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmDeleteDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? 'label'}?`}
        description={`Every project loses ${deleting?.name ?? 'this label'}.`}
        onCancel={() => {
          setDeleting(null);
        }}
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (target !== null) {
            run(remove(target), 'Could not delete that label.');
          }
        }}
      />
    </div>
  );
};

export default ProjectLabelsEditor;
