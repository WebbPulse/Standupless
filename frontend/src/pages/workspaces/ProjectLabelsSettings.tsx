/**
 * The Project labels page of workspace settings: the one set of labels every
 * project in the workspace draws from, as Linear's project labels. Any member
 * reads them with how many projects carry each; a workspace owner or admin
 * adds, renames, recolors and deletes them, and a deleted label leaves every
 * project that carried it.
 */

import React, { useState } from 'react';
import { LuEllipsis } from 'react-icons/lu';
import { useMutationWithRefetch } from '@webbpulse/api-client/react';
import {
  createProjectLabel,
  deleteProjectLabel,
  updateProjectLabel,
} from '../../api/projectLabels';
import { ErrorAlert } from '../../components/ui/alert';
import { LabelChip } from '../../components/ui/badge';
import Button, { IconButton } from '../../components/ui/button';
import Field from '../../components/ui/field';
import Menu, { MenuItem } from '../../components/ui/menu';
import { SkeletonRows } from '../../components/ui/skeleton';
import { ConfirmDeleteDialog } from '../../components/workflow/InheritedControls';
import LabelColorPicker from '../../components/workflow/LabelColorPicker';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useProjectLabels } from '../../hooks/useProjectLabels';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { STATUS_COLOR_VALUES } from '../../lib/statusAppearance';
import type {
  ProjectLabelCreate,
  ProjectLabelRead,
  ProjectLabelUpdate,
} from '../../types/Api';

/** The color a new project label starts on. */
const DEFAULT_COLOR = STATUS_COLOR_VALUES.blue;

/** How a label's project count reads. */
const countText = (count: number): string =>
  count === 1 ? '1 project' : `${count} projects`;

/** Lists and edits the workspace's project labels. */
const ProjectLabelsSettings: React.FC = () => {
  const { workspace } = useWorkspace();
  const workspaceId = workspace?.id ?? '';
  const canEdit = canManageMembers(workspace?.role);
  const { labels, error, isLoading, queryKey } = useProjectLabels(workspaceId);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [isAdding, setIsAdding] = useState(false);
  const [deleting, setDeleting] = useState<ProjectLabelRead | null>(null);

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
    void create({ name: name.trim(), color })
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

  const renderRow = (label: ProjectLabelRead): React.ReactNode => (
    <li
      key={label.id}
      className="flex min-h-row flex-wrap items-center gap-3 border-b border-line py-1 pl-3 pr-3 transition-colors duration-100 last:border-b-0 hover:bg-surface"
    >
      {canEdit ? (
        <>
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
        </>
      ) : (
        <LabelChip color={label.color} name={label.name} />
      )}
      <span className="text-xs text-text-muted">
        {countText(label.project_count)}
      </span>
      {canEdit && (
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
      )}
    </li>
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
          <h2 className="text-base font-semibold">Project labels</h2>
          <p className="text-sm text-text-muted">
            Labels for projects, shared by every team. Set them on a project,
            show them on the projects list and filter by them. Only a workspace
            admin changes them here.
          </p>
        </div>

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
              id="new-project-label"
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

        {isLoading && labels.length === 0 ? (
          <SkeletonRows count={4} label="Loading project labels" />
        ) : labels.length === 0 ? (
          <p className="text-sm text-text-muted">No project labels yet.</p>
        ) : (
          <ul className="rounded-md border border-line">
            {labels.map(renderRow)}
          </ul>
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
    </WorkspaceShell>
  );
};

export default ProjectLabelsSettings;
