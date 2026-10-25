/**
 * The menu a right click opens on a row or a card: every property command,
 * setting or removing the parent issue, duplicating one issue or converting
 * it into a project, marking a relation to another issue, the copy commands
 * (git branch name included), and archive and delete, each with the key that
 * does the same from the keyboard. It acts on the selection when the row clicked is
 * part of it, and on that one issue otherwise.
 */

import React, { useContext } from 'react';
import { useInRouterContext } from 'react-router-dom';
import type { IconType } from 'react-icons';
import {
  LuArchive,
  LuArchiveRestore,
  LuCalendar,
  LuCircleDashed,
  LuCopy,
  LuCopyPlus,
  LuCornerUpLeft,
  LuEye,
  LuGitBranch,
  LuHexagon,
  LuLink2,
  LuMilestone,
  LuPlus,
  LuRefreshCw,
  LuSignal,
  LuSquareArrowOutUpRight,
  LuTag,
  LuTrash2,
  LuTriangle,
  LuUnlink,
  LuUserRound,
  LuUserRoundCheck,
} from 'react-icons/lu';
import type { OrderedIssueRead } from '../../../api/issues';
import { allArchived } from '../../../lib/issueDisplay';
import {
  COPY_BRANCH_KEYS,
  COPY_ISSUE_ID_KEYS,
  COPY_ISSUE_URL_KEYS,
} from '../../../lib/copyIssue';
import type { LinkType } from '../../../types/Api';
import { WorkspaceContext } from '../../../contexts/WorkspaceContextDefinition';
import { memberPath } from '../../../lib/paths';
import {
  ContextMenu,
  MenuItem,
  MenuSeparator,
  MenuShortcut,
} from '../../ui/menu';
import {
  CONVERT_TO_PROJECT_LABEL,
  DUPLICATE_ISSUE_LABEL,
} from '../../../lib/issueConversion';
import { RELATION_COMMANDS } from '../RelationGlyphs';
import { SET_PARENT_KEYS } from '../SetParentDialog';
import {
  ARCHIVE_ISSUE_KEYS,
  DELETE_ISSUE_KEYS,
  PROPERTY_KEYS,
  type CommandProperty,
} from './propertyKeys';

/** The property commands in menu order, with their labels and icons. */
const PROPERTY_ITEMS: {
  property: CommandProperty;
  label: string;
  icon: IconType;
}[] = [
  { property: 'status', label: 'Status', icon: LuCircleDashed },
  { property: 'priority', label: 'Priority', icon: LuSignal },
  { property: 'assignee', label: 'Assignee', icon: LuUserRound },
  { property: 'labels', label: 'Labels', icon: LuTag },
  { property: 'estimate', label: 'Estimate', icon: LuTriangle },
  { property: 'milestone', label: 'Milestone', icon: LuMilestone },
  { property: 'cycle', label: 'Cycle', icon: LuRefreshCw },
  { property: 'project', label: 'Project', icon: LuHexagon },
  { property: 'dueDate', label: 'Due date', icon: LuCalendar },
];

/** Props for IssueRowMenu. */
export interface IssueRowMenuProps {
  /** The pointer's position in viewport coordinates. */
  x: number;
  y: number;
  /** The issues the menu acts on, one or the selection. */
  issues: OrderedIssueRead[];
  canEdit: boolean;
  /** Whether estimates can be set on these issues. */
  estimates: boolean;
  /** Whether a milestone can be set, true only inside one project's list. */
  milestones: boolean;
  onProperty: (property: CommandProperty) => void;
  /** Opens the parent picker on the issues. */
  onSetParent?: (() => void) | undefined;
  /** Detaches the issues from their parent, while any of them has one. */
  onRemoveParent?: (() => void) | undefined;
  /** Assigns the issues to the signed in person, when they can take them. */
  onAssignToMe?: (() => void) | undefined;
  /** Files a copy of the issue, offered for one issue at a time. */
  onDuplicate?: (() => void) | undefined;
  /** Asks to convert the issue into a project, offered for one issue at a time. */
  onConvertToProject?: (() => void) | undefined;
  /**
   * Opens the relation dialog on the issue starting on a relation, offered
   * for one issue at a time.
   */
  onRelation?: ((type: LinkType) => void) | undefined;
  onCopyId: () => void;
  onCopyUrl: () => void;
  /** Copies the issue's git branch name, offered for one issue at a time. */
  onCopyBranch?: (() => void) | undefined;
  /** Opens the one issue, absent for a selection. */
  onOpen?: (() => void) | undefined;
  /**
   * Opens the issues in new desktop app tabs, absent in a browser, where the
   * browser's own link menu does this.
   */
  onOpenInNewTab?: (() => void) | undefined;
  /** Peeks the one issue, absent for a selection. */
  onPeek?: (() => void) | undefined;
  /** Archives the issues, or restores them when all are archived. */
  onArchive?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
  onClose: () => void;
  /** The key each property opens on, when the layout moves one. */
  keys?: Record<CommandProperty, string>;
}

/** The menu. */
export const IssueRowMenu: React.FC<IssueRowMenuProps> = ({
  x,
  y,
  issues,
  canEdit,
  estimates,
  milestones,
  onProperty,
  onSetParent,
  onRemoveParent,
  onAssignToMe,
  onDuplicate,
  onConvertToProject,
  onRelation,
  onCopyId,
  onCopyUrl,
  onCopyBranch,
  onOpen,
  onOpenInNewTab,
  onPeek,
  onArchive,
  onDelete,
  onClose,
  keys = PROPERTY_KEYS,
}) => {
  const single = issues.length === 1 ? issues[0] : undefined;
  const workspace = useContext(WorkspaceContext)?.workspace ?? null;
  const routed = useInRouterContext();
  const assigneePage =
    routed &&
    workspace !== null &&
    single !== undefined &&
    single.assignee_id !== null
      ? memberPath(workspace.slug, single.assignee_id)
      : null;
  const restoring = allArchived(issues);
  const properties = PROPERTY_ITEMS.filter(
    (item) =>
      (estimates || item.property !== 'estimate') &&
      (milestones || item.property !== 'milestone')
  );
  return (
    <ContextMenu
      x={x}
      y={y}
      label={
        single === undefined
          ? `${String(issues.length)} issues`
          : `${single.key} actions`
      }
      onClose={onClose}
    >
      {(onOpen !== undefined ||
        onOpenInNewTab !== undefined ||
        onPeek !== undefined) && (
        <>
          {onOpen !== undefined && (
            <MenuItem onSelect={onOpen}>
              <LuSquareArrowOutUpRight
                aria-hidden="true"
                className="h-3.5 w-3.5"
              />
              Open issue
              <MenuShortcut keys="enter" />
            </MenuItem>
          )}
          {onOpenInNewTab !== undefined && (
            <MenuItem onSelect={onOpenInNewTab}>
              <LuPlus aria-hidden="true" className="h-3.5 w-3.5" />
              {issues.length === 1 ? 'Open in new tab' : 'Open in new tabs'}
            </MenuItem>
          )}
          {onPeek !== undefined && (
            <MenuItem onSelect={onPeek}>
              <LuEye aria-hidden="true" className="h-3.5 w-3.5" />
              Peek
              <MenuShortcut keys="space" />
            </MenuItem>
          )}
          {assigneePage !== null && (
            <MenuItem to={assigneePage}>
              <LuUserRound aria-hidden="true" className="h-3.5 w-3.5" />
              Open assignee page
            </MenuItem>
          )}
          <MenuSeparator />
        </>
      )}
      {canEdit && (
        <>
          {properties.map((item) => (
            <MenuItem
              key={item.property}
              onSelect={() => {
                onProperty(item.property);
              }}
            >
              <item.icon aria-hidden="true" className="h-3.5 w-3.5" />
              {item.label}
              <MenuShortcut keys={keys[item.property]} />
            </MenuItem>
          ))}
          {onSetParent !== undefined && (
            <MenuItem onSelect={onSetParent}>
              <LuCornerUpLeft aria-hidden="true" className="h-3.5 w-3.5" />
              Set parent issue…
              <MenuShortcut keys={SET_PARENT_KEYS} />
            </MenuItem>
          )}
          {onRemoveParent !== undefined && (
            <MenuItem onSelect={onRemoveParent}>
              <LuUnlink aria-hidden="true" className="h-3.5 w-3.5" />
              Remove parent
            </MenuItem>
          )}
          {onAssignToMe !== undefined && (
            <MenuItem onSelect={onAssignToMe}>
              <LuUserRoundCheck aria-hidden="true" className="h-3.5 w-3.5" />
              Assign to me
              <MenuShortcut keys="i" />
            </MenuItem>
          )}
          {onDuplicate !== undefined && (
            <MenuItem onSelect={onDuplicate}>
              <LuCopyPlus aria-hidden="true" className="h-3.5 w-3.5" />
              {DUPLICATE_ISSUE_LABEL}
            </MenuItem>
          )}
          {onConvertToProject !== undefined && (
            <MenuItem onSelect={onConvertToProject}>
              <LuHexagon aria-hidden="true" className="h-3.5 w-3.5" />
              {`${CONVERT_TO_PROJECT_LABEL}…`}
            </MenuItem>
          )}
          <MenuSeparator />
          {onRelation !== undefined && (
            <>
              {RELATION_COMMANDS.map((command) => (
                <MenuItem
                  key={command.type}
                  onSelect={() => {
                    onRelation(command.type);
                  }}
                >
                  <command.icon aria-hidden="true" className="h-3.5 w-3.5" />
                  {`${command.label}…`}
                  <MenuShortcut keys={command.keys} />
                </MenuItem>
              ))}
              <MenuSeparator />
            </>
          )}
        </>
      )}
      <MenuItem onSelect={onCopyId}>
        <LuCopy aria-hidden="true" className="h-3.5 w-3.5" />
        Copy ID
        <MenuShortcut keys={COPY_ISSUE_ID_KEYS} />
      </MenuItem>
      <MenuItem onSelect={onCopyUrl}>
        <LuLink2 aria-hidden="true" className="h-3.5 w-3.5" />
        Copy link
        <MenuShortcut keys={COPY_ISSUE_URL_KEYS} />
      </MenuItem>
      {onCopyBranch !== undefined && (
        <MenuItem onSelect={onCopyBranch}>
          <LuGitBranch aria-hidden="true" className="h-3.5 w-3.5" />
          Copy git branch name
          <MenuShortcut keys={COPY_BRANCH_KEYS} />
        </MenuItem>
      )}
      {canEdit && (onArchive !== undefined || onDelete !== undefined) && (
        <>
          <MenuSeparator />
          {onArchive !== undefined && (
            <MenuItem onSelect={onArchive}>
              {restoring ? (
                <LuArchiveRestore aria-hidden="true" className="h-3.5 w-3.5" />
              ) : (
                <LuArchive aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              {restoring ? 'Restore' : 'Archive'}
              <MenuShortcut keys={ARCHIVE_ISSUE_KEYS} />
            </MenuItem>
          )}
          {onDelete !== undefined && (
            <MenuItem danger onSelect={onDelete}>
              <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
              Delete
              <MenuShortcut keys={DELETE_ISSUE_KEYS} />
            </MenuItem>
          )}
        </>
      )}
    </ContextMenu>
  );
};

export default IssueRowMenu;
