/**
 * The pause and working hours part of notification settings, as in Linear.
 * A pause holds email and desktop notifications until a chosen moment and can
 * be ended early. Working hours hold them outside a weekly schedule read in
 * the person's timezone. Either way the inbox keeps filling, held emails go
 * out as one digest once the person may be reached again, and an opt in lets
 * direct mentions and urgent assignments through.
 *
 * Days save as they are toggled and times save when the field is left, the
 * way the rest of the page saves each change as it happens.
 */

import React, { useId, useState } from 'react';
import { LuBell, LuBellOff } from 'react-icons/lu';
import { useNotificationPause } from '../../hooks/useNotificationPause';
import {
  DEFAULT_WORKING_HOURS,
  WORKING_DAYS,
  WORKING_DAY_LABELS,
  workingHoursProblem,
} from '../../lib/notificationPause';
import { reminderLabel } from '../../lib/reminders';
import { cn } from '../../lib/cn';
import type {
  UserPreferencesUpdate,
  UserRead,
  WorkingDay,
  WorkingHours,
} from '../../types/Api';
import Button from '../ui/button';
import Checkbox from '../ui/checkbox';
import Input from '../ui/input';
import PauseNotificationsDialog from './PauseNotificationsDialog';

/** Props for NotificationScheduleSettings. */
export interface NotificationScheduleSettingsProps {
  user: UserRead;
  /** The zone working hours are read in, shown beside the schedule. */
  zone: string;
  saving: boolean;
  save: (body: UserPreferencesUpdate) => void;
}

/** The pause control, the working hours schedule and the urgent bypass. */
const NotificationScheduleSettings: React.FC<
  NotificationScheduleSettingsProps
> = ({ user, zone, saving, save }) => {
  const pause = useNotificationPause();
  const [pauseOpen, setPauseOpen] = useState(false);
  const stored = user.working_hours ?? null;
  const [edited, setDraft] = useState<WorkingHours | null>(null);
  const draft = edited ?? stored ?? DEFAULT_WORKING_HOURS;
  const startId = useId();
  const endId = useId();

  const problem = stored === null ? null : workingHoursProblem(draft);

  const saveHours = (next: WorkingHours): void => {
    setDraft(next);
    if (workingHoursProblem(next) !== null) return;
    if (
      stored !== null &&
      next.start === stored.start &&
      next.end === stored.end &&
      next.days.join() === stored.days.join()
    ) {
      return;
    }
    save({ working_hours: next });
  };

  const toggleDay = (day: WorkingDay, on: boolean): void => {
    const days = WORKING_DAYS.filter((one) =>
      one === day ? on : draft.days.includes(one)
    );
    saveHours({ ...draft, days });
  };

  return (
    <div className="space-y-3 rounded-md border border-line p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-text">Pause notifications</p>
          <p className="text-xs text-text-faint">
            {pause.pausedUntil === null
              ? 'Hold email and desktop notifications for a while. Your inbox still fills, and held emails arrive as one digest when the pause ends.'
              : `Paused until ${reminderLabel(pause.pausedUntil, zone)}. Your inbox still fills.`}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {pause.pausedUntil !== null && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pause.saving}
              onClick={() => void pause.resume()}
            >
              <LuBell aria-hidden="true" className="h-3.5 w-3.5" />
              Resume
            </Button>
          )}
          <Button
            size="sm"
            disabled={pause.saving}
            onClick={() => {
              setPauseOpen(true);
            }}
          >
            <LuBellOff aria-hidden="true" className="h-3.5 w-3.5" />
            {pause.pausedUntil === null ? 'Pause' : 'Change'}
          </Button>
        </div>
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <Checkbox
          label="Only notify me during working hours"
          checked={stored !== null}
          disabled={saving}
          onChange={(event) => {
            save({
              working_hours: event.target.checked ? draft : null,
            });
          }}
        />
        <p className="pl-5.5 text-xs text-text-faint">
          Outside these hours email and desktop notifications wait, and held
          emails arrive as one digest when your day starts. Hours are read in{' '}
          {zone}, the timezone above.
        </p>
        {stored !== null && (
          <div className="space-y-2 pl-5.5">
            <fieldset className="flex flex-wrap gap-1" disabled={saving}>
              <legend className="sr-only">Working days</legend>
              {WORKING_DAYS.map((day) => {
                const on = draft.days.includes(day);
                return (
                  <label
                    key={day}
                    className={cn(
                      'flex h-7 cursor-pointer items-center rounded-sm border px-2 text-xs select-none',
                      on
                        ? 'border-accent bg-accent-soft text-text'
                        : 'border-line text-text-muted'
                    )}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={on}
                      onChange={(event) => {
                        toggleDay(day, event.target.checked);
                      }}
                    />
                    {WORKING_DAY_LABELS[day]}
                  </label>
                );
              })}
            </fieldset>
            <div className="flex items-center gap-2 text-sm text-text">
              <label htmlFor={startId} className="sr-only">
                Start time
              </label>
              <Input
                id={startId}
                type="time"
                className="w-32"
                value={draft.start}
                disabled={saving}
                onChange={(event) => {
                  setDraft({ ...draft, start: event.target.value });
                }}
                onBlur={() => {
                  saveHours(draft);
                }}
              />
              <span className="text-text-muted">to</span>
              <label htmlFor={endId} className="sr-only">
                End time
              </label>
              <Input
                id={endId}
                type="time"
                className="w-32"
                value={draft.end}
                disabled={saving}
                onChange={(event) => {
                  setDraft({ ...draft, end: event.target.value });
                }}
                onBlur={() => {
                  saveHours(draft);
                }}
              />
            </div>
            {problem !== null && (
              <p role="alert" className="text-xs text-danger">
                {problem}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="space-y-1 border-t border-line pt-3">
        <Checkbox
          label="Let urgent notifications through"
          checked={user.urgent_bypasses_pause ?? false}
          disabled={saving}
          onChange={(event) => {
            save({ urgent_bypasses_pause: event.target.checked });
          }}
        />
        <p className="pl-5.5 text-xs text-text-faint">
          Direct mentions, and assignments on urgent issues, still arrive while
          you are paused or outside working hours.
        </p>
      </div>

      <PauseNotificationsDialog
        open={pauseOpen}
        control={pause}
        workingHours={stored}
        onClose={() => {
          setPauseOpen(false);
        }}
      />
    </div>
  );
};

export default NotificationScheduleSettings;
