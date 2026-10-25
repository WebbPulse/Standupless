/**
 * "Remind me" on a project, an initiative or a document: the palette commands,
 * the banner that shows a pending reminder at the top of the page, and the
 * dialog that picks the moment, as one hook each page calls once. The page's
 * own menu opens the same dialog through `open`.
 *
 * The commands are "Remind me about this {noun}…", bound to H on a document
 * only because H already changes health on a project or an initiative, and
 * "Cancel reminder" while one is set. Clicking the banner reschedules it.
 */

import React, { useState } from 'react';
import { LuBellOff, LuClock } from 'react-icons/lu';
import {
  useEntityReminder,
  type EntityReminder,
} from '../../hooks/useEntityReminder';
import { useShortcut } from '../../hooks/useShortcuts';
import { reminderLabel } from '../../lib/reminders';
import type { ReminderEntityType } from '../../types/Api';
import RemindMeDialog from '../issues/RemindMeDialog';

/** The kinds of page that take a reminder through this hook. */
export type RemindMeEntity = Exclude<ReminderEntityType, 'issue'>;

/** The menu entry's label on every page. */
export const REMIND_ME_MENU_LABEL = 'Remind me…';

/** The palette's label for setting a reminder on a page's subject. */
export const remindMeCommandLabel = (entityType: RemindMeEntity): string =>
  `Remind me about this ${entityType}…`;

/** What useRemindMe takes. */
export interface RemindMeOptions {
  workspaceId: string;
  entityType: RemindMeEntity;
  /** The subject's id, empty while the page is still loading it. */
  entityId: string;
  /** The subject's title, named in the dialog. */
  subject: string;
  /** The palette group the commands list under, such as "Project". */
  group: string;
  /** The key bound to the set command, or empty for the palette alone. */
  keys?: string;
}

/** What useRemindMe returns. */
export interface RemindMe {
  reminder: EntityReminder;
  /** Opens the dialog, for the page's menu entry. */
  open: () => void;
  /** The pending reminder's banner for the top of the page, or null when none is set. */
  banner: React.ReactNode;
  /** The dialog, rendered anywhere on the page since it overlays it. */
  dialog: React.ReactNode;
}

/** Props for ReminderBanner. */
interface ReminderBannerProps {
  remindAt: string;
  onChange: () => void;
  onCancel: () => void;
}

/** The line at the top of a page saying when its pending reminder lands, with ways to move or drop it. */
const ReminderBanner: React.FC<ReminderBannerProps> = ({
  remindAt,
  onChange,
  onCancel,
}) => (
  <div
    role="status"
    className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm text-text-muted"
  >
    <LuClock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
    <button
      type="button"
      className="min-w-0 flex-1 truncate text-left hover:text-text"
      onClick={onChange}
    >
      Reminder set for {reminderLabel(remindAt)}.
    </button>
    <button
      type="button"
      className="shrink-0 font-medium text-text-muted hover:text-text"
      onClick={onChange}
    >
      Change
    </button>
    <button
      type="button"
      className="flex shrink-0 items-center gap-1 font-medium text-text-muted hover:text-text"
      onClick={onCancel}
    >
      <LuBellOff aria-hidden="true" className="h-3.5 w-3.5" />
      Cancel reminder
    </button>
  </div>
);

/** Binds "Remind me" on one page's subject and returns what the page renders and opens. */
export const useRemindMe = ({
  workspaceId,
  entityType,
  entityId,
  subject,
  group,
  keys = '',
}: RemindMeOptions): RemindMe => {
  const reminder = useEntityReminder(workspaceId, entityType, entityId);
  const [opened, setOpened] = useState(false);
  const ready = workspaceId !== '' && entityId !== '';

  useShortcut({
    keys,
    label: remindMeCommandLabel(entityType),
    scope: 'page',
    group,
    enabled: ready,
    handler: (event) => {
      event?.preventDefault();
      setOpened(true);
    },
  });

  useShortcut({
    keys: '',
    label: 'Cancel reminder',
    scope: 'page',
    group,
    enabled: ready && reminder.reminder !== null,
    handler: () => {
      reminder.cancel();
    },
  });

  const open = (): void => {
    setOpened(true);
  };

  const banner =
    reminder.reminder === null ? null : (
      <ReminderBanner
        remindAt={reminder.reminder.remind_at}
        onChange={open}
        onCancel={reminder.cancel}
      />
    );

  const dialog = (
    <RemindMeDialog
      open={opened}
      subject={subject}
      reminder={reminder}
      onClose={() => {
        setOpened(false);
      }}
    />
  );

  return { reminder, open, banner, dialog };
};

export default useRemindMe;
