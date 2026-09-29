/**
 * The issue page's keyboard commands, the same ones a list offers on its
 * focused row: s, p, a, l and e, Shift+M, Shift+C, Shift+P and Shift+D open the
 * property pickers, i assigns the issue to the viewer or back off them, and
 * Cmd or Ctrl+Delete deletes the issue after a confirmation. The
 * pickers are the list's own, fed the page's lists and writing through the
 * page's optimistic update, so both surfaces behave alike. The confirmation
 * can be held by the page, so its menu's Delete opens the same dialog.
 */

import React, { useMemo, useState } from 'react';
import type { OrderedIssueRead } from '../../api/issues';
import { usePublishIssueSubject } from '../../hooks/useIssueSubject';
import { useShortcut } from '../../hooks/useShortcuts';
import { changeToUpdate } from '../../lib/issueChange';
import {
  changeIsNoop,
  defaultViewState,
  type IssueContext,
} from '../../lib/issueView';
import type {
  CycleRead,
  EstimateScale,
  IssueRead,
  IssueUpdate,
  LabelRead,
  MilestoneRead,
  ProjectRead,
  StatusRead,
} from '../../types/Api';
import type { Assignable } from '../../lib/issuePeople';
import ConfirmDeleteIssuesDialog from './ConfirmDeleteIssuesDialog';
import {
  IssueViewEnvContext,
  type IssueViewEnv,
} from './view/IssueViewContext';
import PropertyCommand from './view/PropertyCommand';
import { PROPERTY_KEYS, type CommandProperty } from './view/propertyKeys';

/** The properties the page binds, with their palette labels. */
const PAGE_PROPERTIES: { property: CommandProperty; label: string }[] = [
  { property: 'status', label: 'Change status' },
  { property: 'priority', label: 'Change priority' },
  { property: 'assignee', label: 'Assign' },
  { property: 'labels', label: 'Change labels' },
  { property: 'estimate', label: 'Set estimate' },
  { property: 'milestone', label: 'Set milestone' },
  { property: 'cycle', label: 'Move to cycle' },
  { property: 'project', label: 'Move to project' },
  { property: 'dueDate', label: 'Set due date' },
];

/** No milestones, shared so the context keeps one identity across renders. */
const NO_MILESTONES: MilestoneRead[] = [];

/** Props for IssuePageCommands. */
export interface IssuePageCommandsProps {
  slug: string;
  issue: IssueRead;
  statuses: StatusRead[];
  labels: LabelRead[];
  people: Assignable[];
  projects: ProjectRead[];
  cycles: CycleRead[];
  /** The milestones of the issue's project, empty when it has none. */
  milestones?: MilestoneRead[];
  estimateScale: EstimateScale;
  currentUserId: string;
  canEdit: boolean;
  /** Writes a patch to the issue, optimistically. */
  onUpdate: (patch: IssueUpdate) => void;
  /** Deletes the issue. Absent when the caller cannot. */
  onDelete?: () => Promise<void>;
  /** Whether the delete confirmation is open, when the page holds it. */
  deleting?: boolean;
  /** Opens or closes the delete confirmation the page holds. */
  onDeletingChange?: (open: boolean) => void;
}

/** Binds one property key to opening its picker. */
const PropertyKey: React.FC<{
  keys: string;
  label: string;
  enabled: boolean;
  onRun: () => void;
}> = ({ keys, label, enabled, onRun }) => {
  useShortcut({
    keys,
    label,
    scope: 'issue',
    group: 'Issue',
    enabled,
    handler: onRun,
  });
  return null;
};

/** The page's pickers and delete, bound to their keys. */
export const IssuePageCommands: React.FC<IssuePageCommandsProps> = ({
  slug,
  issue,
  statuses,
  labels,
  people,
  projects,
  cycles,
  milestones = NO_MILESTONES,
  estimateScale,
  currentUserId,
  canEdit,
  onUpdate,
  onDelete,
  deleting: heldDeleting,
  onDeletingChange,
}) => {
  const [command, setCommand] = useState<CommandProperty | null>(null);
  const [ownDeleting, setOwnDeleting] = useState(false);
  const deleting = heldDeleting ?? ownDeleting;
  const setDeleting = (open: boolean): void => {
    setOwnDeleting(open);
    onDeletingChange?.(open);
  };

  const context = useMemo<IssueContext>(
    () => ({
      statuses: statuses.map((status) => ({
        ...status,
        team_id: issue.team_id,
      })),
      labels: labels.map((label) => ({ ...label, team_id: issue.team_id })),
      people,
      projects,
      cycles,
      milestones,
      currentUserId,
    }),
    [
      statuses,
      labels,
      people,
      projects,
      cycles,
      milestones,
      currentUserId,
      issue.team_id,
    ]
  );

  const env = useMemo<IssueViewEnv>(
    () => ({
      slug,
      state: defaultViewState('list'),
      context,
      forTeam: () => context,
      scaleFor: () => estimateScale,
      canEdit,
      update: (ids, change) => {
        if (!ids.includes(issue.id)) return;
        const own = typeof change === 'function' ? change(issue) : change;
        if (own === null || changeIsNoop(issue, own)) return;
        onUpdate(changeToUpdate(issue, own));
      },
      createLabel: () => Promise.resolve(null),
      focusedId: issue.id,
      selected: new Set<string>(),
      peekedKey: null,
      focus: () => undefined,
      toggleSelected: () => undefined,
      peek: () => undefined,
    }),
    [slug, context, estimateScale, canEdit, issue, onUpdate]
  );

  const targets = useMemo<OrderedIssueRead[]>(() => [issue], [issue]);

  usePublishIssueSubject({ key: issue.key, title: issue.title });

  const assignable = people.some((person) => person.user_id === currentUserId);
  useShortcut({
    keys: 'i',
    label: 'Assign to me',
    scope: 'issue',
    group: 'Issue',
    enabled: canEdit && assignable,
    handler: () => {
      onUpdate({
        assignee_id: issue.assignee_id === currentUserId ? null : currentUserId,
      });
    },
  });

  useShortcut({
    keys: 'mod+backspace',
    label: 'Delete issue',
    scope: 'issue',
    group: 'Issue',
    enabled: canEdit && onDelete !== undefined,
    handler: (event) => {
      event?.preventDefault();
      setDeleting(true);
    },
  });

  return (
    <IssueViewEnvContext.Provider value={env}>
      {PAGE_PROPERTIES.map(({ property, label }) => (
        <PropertyKey
          key={property}
          keys={PROPERTY_KEYS[property]}
          label={label}
          enabled={
            canEdit &&
            (property !== 'estimate' || estimateScale !== 'off') &&
            (property !== 'milestone' || issue.project_id !== null)
          }
          onRun={() => {
            setCommand(property);
          }}
        />
      ))}
      {command !== null && (
        <PropertyCommand
          property={command}
          issues={targets}
          onClose={() => {
            setCommand(null);
          }}
        />
      )}
      {deleting && onDelete !== undefined && (
        <ConfirmDeleteIssuesDialog
          issues={targets}
          onClose={() => {
            setDeleting(false);
          }}
          onConfirm={onDelete}
        />
      )}
    </IssueViewEnvContext.Provider>
  );
};

export default IssuePageCommands;
