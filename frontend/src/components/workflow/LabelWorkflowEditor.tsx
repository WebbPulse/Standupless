/**
 * The label list both label settings pages draw, in name order. A label the
 * caller may edit carries its color picker, an inline name and a delete in its
 * menu. On a team page the workspace's labels appear among the team's own,
 * marked as inherited and offered only the team overrides.
 */

import React, { useState } from 'react';
import { LuEllipsis } from 'react-icons/lu';
import { errorMessage } from '../../lib/errors';
import { STATUS_COLOR_VALUES } from '../../lib/statusAppearance';
import { isInherited, sortLabels, visibleRows } from '../../lib/workflow';
import type {
  LabelCreate,
  LabelRead,
  LabelUpdate,
  OverrideUpdate,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import { LabelChip } from '../ui/badge';
import Button, { IconButton } from '../ui/button';
import Field from '../ui/field';
import Menu, { MenuItem } from '../ui/menu';
import {
  ConfirmDeleteDialog,
  HiddenToggle,
  InheritedMarkers,
  InheritedRowMenu,
} from './InheritedControls';
import LabelColorPicker from './LabelColorPicker';

/** The writes the editor asks for. Each rejects as the API does. */
export interface LabelEditorActions {
  create: (body: LabelCreate) => Promise<unknown>;
  update: (label: LabelRead, body: LabelUpdate) => Promise<unknown>;
  remove: (label: LabelRead) => Promise<unknown>;
  override?: (label: LabelRead, body: OverrideUpdate) => Promise<unknown>;
  reset?: (label: LabelRead) => Promise<unknown>;
}

/** Props for LabelWorkflowEditor. */
export interface LabelWorkflowEditorProps {
  /** Every label to list, hidden inherited ones included on a team page. */
  labels: readonly LabelRead[];
  /** Whose labels these are: the workspace's, or one team's. */
  scope: 'workspace' | 'team';
  canEdit: boolean;
  actions: LabelEditorActions;
  /** Where an inherited label is edited, for the team page's menu. */
  workspaceSettingsPath?: string;
}

/** The color a new label starts on. */
const DEFAULT_COLOR = STATUS_COLOR_VALUES.blue;

/** Lists labels and edits the ones the caller may change. */
export const LabelWorkflowEditor: React.FC<LabelWorkflowEditorProps> = ({
  labels,
  scope,
  canEdit,
  actions,
  workspaceSettingsPath = '',
}) => {
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [isAdding, setIsAdding] = useState(false);
  const [deleting, setDeleting] = useState<LabelRead | null>(null);

  const { override, reset } = actions;
  const visible = visibleRows(labels);
  const hiddenCount = labels.length - visible.length;
  const shown = sortLabels(showHidden ? labels : visible);
  const editable = (label: LabelRead): boolean =>
    canEdit && (scope === 'workspace' || !isInherited(label));

  const run = (write: Promise<unknown>, fallback: string): void => {
    setError(null);
    void write.catch((cause: unknown) => {
      setError(errorMessage(cause, fallback));
    });
  };

  const onAdd = (event: React.FormEvent): void => {
    event.preventDefault();
    if (name.trim() === '' || isAdding) return;
    setError(null);
    setIsAdding(true);
    void actions
      .create({ name: name.trim(), color })
      .then(() => {
        setName('');
        setColor(DEFAULT_COLOR);
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause, 'Could not add that label.'));
      })
      .finally(() => {
        setIsAdding(false);
      });
  };

  const onRename = (label: LabelRead, value: string): void => {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === label.name) return;
    run(
      actions.update(label, { name: trimmed }),
      'Could not rename that label.'
    );
  };

  const onDelete = (label: LabelRead): void => {
    if (scope === 'workspace') {
      setDeleting(label);
      return;
    }
    run(actions.remove(label), 'Could not delete that label.');
  };

  return (
    <div className="space-y-4">
      {scope === 'team' && (
        <HiddenToggle
          count={hiddenCount}
          checked={showHidden}
          onChange={setShowHidden}
        />
      )}
      {error !== null && <ErrorAlert message={error} />}

      {canEdit && (
        <form
          aria-label="Add a label"
          className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2"
          onSubmit={onAdd}
        >
          <LabelColorPicker
            name={name.trim()}
            value={color}
            onChange={setColor}
          />
          <Field
            id={`new-label-${scope}`}
            label="New label"
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

      {shown.length === 0 ? (
        <p className="text-sm text-text-muted">
          {scope === 'workspace'
            ? 'No workspace labels yet.'
            : 'This team has no labels.'}
        </p>
      ) : (
        <ul className="rounded-md border border-line">
          {shown.map((label) => (
            <li
              key={label.id}
              className={
                'flex min-h-row flex-wrap items-center gap-3 border-b border-line px-3 py-1 transition-colors duration-100 last:border-b-0 hover:bg-surface' +
                (label.hidden === true ? ' opacity-60' : '')
              }
            >
              {editable(label) ? (
                <>
                  <LabelColorPicker
                    name={label.name}
                    value={label.color}
                    onChange={(next) => {
                      if (next === label.color) return;
                      run(
                        actions.update(label, { color: next }),
                        'Could not recolor that label.'
                      );
                    }}
                  />
                  <Field
                    key={`${label.id}-${label.name}`}
                    id={`label-name-${label.id}`}
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
                          onDelete(label);
                        }}
                      >
                        Delete
                      </MenuItem>
                    </Menu>
                  </div>
                </>
              ) : (
                <>
                  <LabelChip color={label.color} name={label.name} />
                  {isInherited(label) && scope === 'team' && (
                    <InheritedMarkers row={label} />
                  )}
                  {isInherited(label) &&
                    scope === 'team' &&
                    canEdit &&
                    override !== undefined &&
                    reset !== undefined && (
                      <div className="ml-auto">
                        <InheritedRowMenu
                          row={label}
                          noun="label"
                          workspaceSettingsPath={workspaceSettingsPath}
                          onOverride={(body) => {
                            run(
                              override(label, body),
                              'Could not change that label for this team.'
                            );
                          }}
                          onReset={() => {
                            run(reset(label), 'Could not reset that label.');
                          }}
                        />
                      </div>
                    )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDeleteDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? 'label'}?`}
        description={`Every team loses ${deleting?.name ?? 'this label'}.`}
        onCancel={() => {
          setDeleting(null);
        }}
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (target !== null) {
            run(actions.remove(target), 'Could not delete that label.');
          }
        }}
      />
    </div>
  );
};

export default LabelWorkflowEditor;
