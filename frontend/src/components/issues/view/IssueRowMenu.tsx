/**
 * The menu a right click opens on a row or a card: every property command,
 * the copy commands, and archive and delete, each with the key that does the
 * same from the keyboard. It acts on the selection when the row clicked is
 * part of it, and on that one issue otherwise.
 */

import React from 'react';
import type { IconType } from 'react-icons';
import {
  LuArchive,
  LuArchiveRestore,
  LuCalendar,
  LuCircleDashed,
  LuCopy,
  LuEye,
  LuHexagon,
  LuLink2,
  LuMilestone,
  LuRefreshCw,
  LuSignal,
  LuSquareArrowOutUpRight,
  LuTag,
  LuTrash2,
  LuTriangle,
  LuUserRound,
  LuUserRoundCheck,
} from 'react-icons/lu';
import type { OrderedIssueRead } from '../../../api/issues';
import { allArchived } from '../../../lib/issueDisplay';
import {
  COPY_ISSUE_ID_KEYS,
  COPY_ISSUE_URL_KEYS,
} from '../../../lib/copyIssue';
import {
  ContextMenu,
  MenuItem,
  MenuSeparator,
  MenuShortcut,
} from '../../ui/menu';
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
  /** Assigns the issues to the signed in person, when they can take them. */
  onAssignToMe?: (() => void) | undefined;
  onCopyId: () => void;
  onCopyUrl: () => void;
  /** Opens the one issue, absent for a selection. */
  onOpen?: (() => void) | undefined;
  /** Peeks the one issue, absent for a selection. */
  onPeek?: (() => void) | undefined;
  /** Archives the issues, or restores them when all are archived. */
  onArchive?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
  onClose: () => void;
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
  onAssignToMe,
  onCopyId,
  onCopyUrl,
  onOpen,
  onPeek,
  onArchive,
  onDelete,
  onClose,
}) => {
  const single = issues.length === 1 ? issues[0] : undefined;
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
      {(onOpen !== undefined || onPeek !== undefined) && (
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
          {onPeek !== undefined && (
            <MenuItem onSelect={onPeek}>
              <LuEye aria-hidden="true" className="h-3.5 w-3.5" />
              Peek
              <MenuShortcut keys="space" />
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
              <MenuShortcut keys={PROPERTY_KEYS[item.property]} />
            </MenuItem>
          ))}
          {onAssignToMe !== undefined && (
            <MenuItem onSelect={onAssignToMe}>
              <LuUserRoundCheck aria-hidden="true" className="h-3.5 w-3.5" />
              Assign to me
              <MenuShortcut keys="i" />
            </MenuItem>
          )}
          <MenuSeparator />
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
