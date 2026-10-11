/**
 * The category grouped status list both workflow settings pages draw. Every
 * category has a heading and its own add row, and a status the caller may edit
 * carries its color and icon picker, an inline name, moves within its
 * category and a menu to recategorise or delete it.
 *
 * On a team page the workspace's statuses appear among the team's own, marked
 * as inherited and offered only the team overrides, and a hidden one shows
 * when the toggle asks for it. Reordering swaps the positions of two statuses
 * the caller may edit, as the contract has no bulk reorder route.
 *
 * Deleting a status asks where its issues go, as Linear does, and the API moves
 * them, archived ones included. The picker offers the other visible statuses,
 * starting on one in the same category.
 */

import React, { useState } from 'react';
import { LuArrowDown, LuArrowUp, LuEllipsis, LuPlus } from 'react-icons/lu';
import { errorMessage } from '../../lib/errors';
import {
  STATUS_CATEGORIES,
  groupByCategory,
  isInherited,
  nextPosition,
  swapNeighbour,
  visibleRows,
} from '../../lib/workflow';
import type {
  OverrideUpdate,
  StatusCategory,
  StatusCreate,
  StatusRead,
  StatusUpdate,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button, { IconButton } from '../ui/button';
import Dialog from '../ui/dialog';
import Field from '../ui/field';
import Menu, { MenuItem, MenuLabel, MenuSeparator } from '../ui/menu';
import { SelectField } from '../ui/select';
import { StatusIcon } from '../ui/StatusIcon';
import {
  StatusAppearancePicker,
  type StatusAppearance,
} from '../team/StatusAppearancePicker';
import {
  HiddenToggle,
  InheritedMarkers,
  InheritedRowMenu,
} from './InheritedControls';

/** The writes the editor asks for. Each rejects as the API does. */
export interface StatusEditorActions {
  create: (body: StatusCreate) => Promise<unknown>;
  update: (status: StatusRead, body: StatusUpdate) => Promise<unknown>;
  swap: (first: StatusRead, second: StatusRead) => Promise<unknown>;
  /** Deletes a status, moving its issues to `replacementId` when one is given. */
  remove: (status: StatusRead, replacementId?: string) => Promise<unknown>;
  override?: (status: StatusRead, body: OverrideUpdate) => Promise<unknown>;
  reset?: (status: StatusRead) => Promise<unknown>;
}

/** Props for StatusWorkflowEditor. */
export interface StatusWorkflowEditorProps {
  /** Every status to list, hidden inherited ones included on a team page. */
  statuses: readonly StatusRead[];
  /** Whose statuses these are: the workspace's, or one team's. */
  scope: 'workspace' | 'team';
  canEdit: boolean;
  actions: StatusEditorActions;
  /** Where an inherited status is edited, for the team page's menu. */
  workspaceSettingsPath?: string;
  /** Where a status the team inherits from its parent team is edited. */
  parentSettingsPath?: string;
}

/** The empty look a new status starts on. */
const NO_LOOK: StatusAppearance = { color: null, icon: null };

/**
 * The statuses a deleted one's issues may move to: every other visible one,
 * those of the same category first, so the default keeps an issue's meaning.
 */
const replacementOptions = (
  statuses: readonly StatusRead[],
  deleting: StatusRead
): StatusRead[] => {
  const others = visibleRows(statuses).filter((row) => row.id !== deleting.id);
  return [
    ...others.filter((row) => row.category === deleting.category),
    ...others.filter((row) => row.category !== deleting.category),
  ];
};

/** Props for DeleteStatusDialog. */
interface DeleteStatusDialogProps {
  status: StatusRead | null;
  options: readonly StatusRead[];
  scope: 'workspace' | 'team';
  onCancel: () => void;
  onConfirm: (status: StatusRead, replacementId: string | undefined) => void;
}

/** Confirms a status delete and picks the status its issues move to. */
const DeleteStatusDialog: React.FC<DeleteStatusDialogProps> = ({
  status,
  options,
  scope,
  onCancel,
  onConfirm,
}) => {
  const [chosen, setChosen] = useState<string>('');
  const replacement =
    options.find((row) => row.id === chosen)?.id ?? options[0]?.id;
  const reach =
    scope === 'workspace'
      ? 'Every team loses this status.'
      : 'The team loses this status.';
  return (
    <Dialog
      open={status !== null}
      onClose={() => {
        setChosen('');
        onCancel();
      }}
      title={`Delete ${status?.name ?? 'status'}?`}
      description={`${reach} Its issues, archived ones included, move to the status you choose.`}
      size="sm"
    >
      <div className="space-y-4">
        {options.length > 0 && (
          <SelectField
            id="replacement-status"
            label="Move issues to"
            value={replacement ?? ''}
            onChange={(event) => {
              setChosen(event.target.value);
            }}
          >
            {options.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </SelectField>
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setChosen('');
              onCancel();
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => {
              setChosen('');
              if (status !== null) onConfirm(status, replacement);
            }}
          >
            Delete
          </Button>
        </div>
      </div>
    </Dialog>
  );
};

/** Lists statuses by category and edits the ones the caller may change. */
export const StatusWorkflowEditor: React.FC<StatusWorkflowEditorProps> = ({
  statuses,
  scope,
  canEdit,
  actions,
  workspaceSettingsPath = '',
  parentSettingsPath,
}) => {
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [adding, setAdding] = useState<StatusCategory | null>(null);
  const [name, setName] = useState('');
  const [look, setLook] = useState<StatusAppearance>(NO_LOOK);
  const [isAdding, setIsAdding] = useState(false);
  const [deleting, setDeleting] = useState<StatusRead | null>(null);

  const visible = visibleRows(statuses);
  const hiddenCount = statuses.length - visible.length;
  const shown = showHidden ? [...statuses] : visible;
  const groups = groupByCategory(shown);
  const { override, reset } = actions;
  const editable = (status: StatusRead): boolean =>
    canEdit && (scope === 'workspace' || !isInherited(status));

  const run = (write: Promise<unknown>, fallback: string): void => {
    setError(null);
    void write.catch((cause: unknown) => {
      setError(errorMessage(cause, fallback));
    });
  };

  const startAdding = (category: StatusCategory): void => {
    setAdding(category);
    setName('');
    setLook(NO_LOOK);
  };

  const onAdd = (event: React.FormEvent): void => {
    event.preventDefault();
    if (adding === null || name.trim() === '' || isAdding) return;
    setError(null);
    setIsAdding(true);
    void actions
      .create({
        name: name.trim(),
        category: adding,
        position: nextPosition(statuses),
        ...(look.color === null ? {} : { color: look.color }),
        ...(look.icon === null ? {} : { icon: look.icon }),
      })
      .then(() => {
        setAdding(null);
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause, 'Could not add that status.'));
      })
      .finally(() => {
        setIsAdding(false);
      });
  };

  const onRename = (status: StatusRead, value: string): void => {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === status.name) return;
    run(
      actions.update(status, { name: trimmed }),
      'Could not rename that status.'
    );
  };

  const onDelete = (status: StatusRead): void => {
    setDeleting(status);
  };

  const move = (
    group: readonly StatusRead[],
    status: StatusRead,
    direction: -1 | 1
  ): void => {
    const other = swapNeighbour(group, status, direction, editable);
    if (other === undefined) return;
    run(actions.swap(status, other), 'Could not reorder the statuses.');
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

      {groups.map((group) => {
        const movable = group.statuses.filter(editable);
        return (
          <section
            key={group.category}
            aria-label={group.label}
            className="rounded-md border border-line"
          >
            <header className="flex h-9 items-center gap-2 border-b border-line bg-surface px-3">
              <h4 className="text-sm font-medium text-text">{group.label}</h4>
              <span className="text-xs text-text-faint">
                {group.statuses.length}
              </span>
              {canEdit && (
                <IconButton
                  label={`Add status to ${group.label}`}
                  size="sm"
                  className="ml-auto"
                  onClick={() => {
                    startAdding(group.category);
                  }}
                >
                  <LuPlus className="h-3.5 w-3.5" />
                </IconButton>
              )}
            </header>
            <ul>
              {group.statuses.length === 0 && adding !== group.category && (
                <li className="px-3 py-2 text-sm text-text-faint">
                  No {group.label.toLowerCase()} statuses.
                </li>
              )}
              {group.statuses.map((status) => {
                const index = movable.findIndex((row) => row.id === status.id);
                return (
                  <li
                    key={status.id}
                    className={
                      'flex min-h-row flex-wrap items-center gap-3 border-b border-line px-3 py-1 transition-colors duration-100 last:border-b-0 hover:bg-surface' +
                      (status.hidden === true ? ' opacity-60' : '')
                    }
                  >
                    {editable(status) ? (
                      <>
                        <StatusAppearancePicker
                          name={status.name}
                          category={status.category}
                          value={{
                            color: status.color ?? null,
                            icon: status.icon ?? null,
                          }}
                          status={status}
                          statuses={visible}
                          onChange={(patch) => {
                            run(
                              actions.update(status, patch),
                              'Could not update that status.'
                            );
                          }}
                        />
                        <Field
                          key={`${status.id}-${status.name}`}
                          id={`status-name-${status.id}`}
                          label={`Name of ${status.name}`}
                          hideLabel
                          className="w-48"
                          defaultValue={status.name}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.currentTarget.blur();
                            }
                          }}
                          onBlur={(event) => {
                            onRename(status, event.target.value);
                          }}
                        />
                        <div className="ml-auto flex items-center gap-1">
                          <IconButton
                            label={`Move ${status.name} up`}
                            size="sm"
                            disabled={index <= 0}
                            onClick={() => {
                              move(group.statuses, status, -1);
                            }}
                          >
                            <LuArrowUp className="h-3.5 w-3.5" />
                          </IconButton>
                          <IconButton
                            label={`Move ${status.name} down`}
                            size="sm"
                            disabled={index < 0 || index === movable.length - 1}
                            onClick={() => {
                              move(group.statuses, status, 1);
                            }}
                          >
                            <LuArrowDown className="h-3.5 w-3.5" />
                          </IconButton>
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
                            <MenuLabel>Move to</MenuLabel>
                            {STATUS_CATEGORIES.filter(
                              (item) => item.value !== status.category
                            ).map((item) => (
                              <MenuItem
                                key={item.value}
                                onSelect={() => {
                                  run(
                                    actions.update(status, {
                                      category: item.value,
                                    }),
                                    'Could not move that status.'
                                  );
                                }}
                              >
                                {item.label}
                              </MenuItem>
                            ))}
                            <MenuSeparator />
                            <MenuItem
                              danger
                              onSelect={() => {
                                onDelete(status);
                              }}
                            >
                              Delete
                            </MenuItem>
                          </Menu>
                        </div>
                      </>
                    ) : (
                      <>
                        <StatusIcon status={status} statuses={visible} />
                        <span className="truncate font-medium text-text">
                          {status.name}
                        </span>
                        {isInherited(status) && scope === 'team' && (
                          <InheritedMarkers row={status} />
                        )}
                        {isInherited(status) &&
                          scope === 'team' &&
                          canEdit &&
                          override !== undefined &&
                          reset !== undefined && (
                            <div className="ml-auto">
                              <InheritedRowMenu
                                row={status}
                                noun="status"
                                workspaceSettingsPath={workspaceSettingsPath}
                                parentSettingsPath={parentSettingsPath}
                                onOverride={(body) => {
                                  run(
                                    override(status, body),
                                    'Could not change that status for this team.'
                                  );
                                }}
                                onReset={() => {
                                  run(
                                    reset(status),
                                    'Could not reset that status.'
                                  );
                                }}
                              />
                            </div>
                          )}
                      </>
                    )}
                  </li>
                );
              })}
              {adding === group.category && (
                <li className="border-t border-line px-3 py-2 first:border-t-0">
                  <form
                    aria-label={`New ${group.label.toLowerCase()} status`}
                    className="flex flex-wrap items-center gap-3"
                    onSubmit={onAdd}
                  >
                    <StatusAppearancePicker
                      name={name.trim()}
                      category={group.category}
                      value={look}
                      statuses={visible}
                      status={{
                        category: group.category,
                        position: nextPosition(statuses),
                        color: look.color,
                        icon: look.icon,
                      }}
                      onChange={(patch) => {
                        setLook((prior) => ({ ...prior, ...patch }));
                      }}
                    />
                    <Field
                      id={`new-status-${group.category}`}
                      label="New status"
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
                    <div className="ml-auto flex items-center gap-2">
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
                </li>
              )}
            </ul>
          </section>
        );
      })}

      <DeleteStatusDialog
        status={deleting}
        scope={scope}
        options={
          deleting === null
            ? []
            : replacementOptions(
                scope === 'workspace' ? statuses : visible,
                deleting
              )
        }
        onCancel={() => {
          setDeleting(null);
        }}
        onConfirm={(target, replacementId) => {
          setDeleting(null);
          run(
            actions.remove(target, replacementId),
            'Could not delete that status.'
          );
        }}
      />
    </div>
  );
};

export default StatusWorkflowEditor;
