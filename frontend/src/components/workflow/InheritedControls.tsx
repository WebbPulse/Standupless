/**
 * The pieces a team settings row uses for a status or label it inherits from
 * the workspace: the markers that say where it comes from and whether the team
 * hid it, the menu that hides, shows, renames and resets it for the team, and
 * the toggle that brings hidden rows into view. An inherited row is never
 * edited in place, so the menu points at workspace settings for that.
 */

import React, { useState } from 'react';
import { LuEllipsis } from 'react-icons/lu';
import {
  isOverridden,
  workspaceName,
  type WorkflowRow,
} from '../../lib/workflow';
import type { OverrideUpdate } from '../../types/Api';
import Badge from '../ui/badge';
import Button, { IconButton } from '../ui/button';
import Checkbox from '../ui/checkbox';
import Dialog from '../ui/dialog';
import Field from '../ui/field';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';

/** The Workspace marker, the Hidden marker and the workspace name of a renamed row. */
export const InheritedMarkers: React.FC<{ row: WorkflowRow }> = ({ row }) => (
  <>
    {row.inherited_name !== undefined &&
      row.inherited_name !== null &&
      row.inherited_name !== row.name && (
        <span className="truncate text-xs text-text-faint">
          Workspace name: {row.inherited_name}
        </span>
      )}
    <Badge tone="neutral">Workspace</Badge>
    {row.hidden === true && <Badge tone="warning">Hidden</Badge>}
  </>
);

/** Props for InheritedRowMenu. */
export interface InheritedRowMenuProps {
  row: WorkflowRow;
  /** What the row is called in the menu copy, as "status" or "label". */
  noun: string;
  /** Where the workspace record is edited. */
  workspaceSettingsPath: string;
  onOverride: (body: OverrideUpdate) => void;
  onReset: () => void;
}

/** The team's actions on one inherited row, and the rename dialog they open. */
export const InheritedRowMenu: React.FC<InheritedRowMenuProps> = ({
  row,
  noun,
  workspaceSettingsPath,
  onOverride,
  onReset,
}) => {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(row.name);
  const original = workspaceName(row);

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') return;
    setRenaming(false);
    if (trimmed === row.name) return;
    onOverride({ name: trimmed === original ? null : trimmed });
  };

  return (
    <>
      <Menu
        label={`${row.name} actions`}
        align="end"
        trigger={(props) => (
          <IconButton label={`Actions for ${row.name}`} size="sm" {...props}>
            <LuEllipsis className="h-3.5 w-3.5" />
          </IconButton>
        )}
      >
        <MenuItem
          onSelect={() => {
            setName(row.name);
            setRenaming(true);
          }}
        >
          Rename for this team
        </MenuItem>
        <MenuItem
          onSelect={() => {
            onOverride({ hidden: row.hidden !== true });
          }}
        >
          {row.hidden === true ? 'Show in this team' : 'Hide from this team'}
        </MenuItem>
        <MenuItem disabled={!isOverridden(row)} onSelect={onReset}>
          Reset to workspace
        </MenuItem>
        <MenuSeparator />
        <MenuItem to={workspaceSettingsPath}>
          Edit in workspace settings
        </MenuItem>
      </Menu>
      <Dialog
        open={renaming}
        onClose={() => {
          setRenaming(false);
        }}
        title={`Rename ${original} for this team`}
        description={`Only this team sees the new name. The workspace ${noun} and every other team keep ${original}.`}
        size="sm"
      >
        <form className="space-y-4" onSubmit={onSubmit}>
          <Field
            id={`override-name-${row.id}`}
            label="Name in this team"
            value={name}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setRenaming(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={name.trim() === ''}
            >
              Save
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
};

/** Props for HiddenToggle. */
export interface HiddenToggleProps {
  /** How many inherited rows the team hid. The toggle is left out at zero. */
  count: number;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** The checkbox that shows the inherited rows a team hid, with their count. */
export const HiddenToggle: React.FC<HiddenToggleProps> = ({
  count,
  checked,
  onChange,
}) =>
  count === 0 ? null : (
    <Checkbox
      label={`Show hidden (${count})`}
      checked={checked}
      onChange={(event) => {
        onChange(event.target.checked);
      }}
    />
  );

/** Props for ConfirmDeleteDialog. */
export interface ConfirmDeleteDialogProps {
  open: boolean;
  title: string;
  description: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/** A short confirmation before a delete that reaches every team. */
export const ConfirmDeleteDialog: React.FC<ConfirmDeleteDialogProps> = ({
  open,
  title,
  description,
  onCancel,
  onConfirm,
}) => (
  <Dialog
    open={open}
    onClose={onCancel}
    title={title}
    description={description}
    size="sm"
  >
    <div className="flex justify-end gap-2">
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="button" variant="danger" onClick={onConfirm}>
        Delete
      </Button>
    </div>
  </Dialog>
);
