/**
 * "Pause notifications": picks how long email and desktop notifications wait,
 * as in Linear. The presets are an hour, tomorrow morning and next week, and a
 * custom date and time is read on the person's own clock, held to the
 * server's thirty day bound. A pause already running shows at the top with a
 * way to resume now, and picking a new moment replaces it. The inbox keeps
 * filling while paused, and held emails go out as one digest when it ends.
 */

import React, { useEffect, useState } from 'react';
import { LuBell, LuBellOff } from 'react-icons/lu';
import type { NotificationPause } from '../../hooks/useNotificationPause';
import { errorMessage } from '../../lib/errors';
import { PAUSE_MAX_DAYS, pausePresets } from '../../lib/notificationPause';
import {
  fromLocalInput,
  reminderLabel,
  reminderProblem,
  toLocalInput,
} from '../../lib/reminders';
import { viewerTimezone } from '../../lib/viewerTimezone';
import type { WorkingHours } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import Field from '../ui/field';

/** Props for PauseNotificationsDialog. */
export interface PauseNotificationsDialogProps {
  open: boolean;
  control: NotificationPause;
  /** The person's working hours, whose start a morning preset lands on. */
  workingHours?: WorkingHours | null;
  onClose: () => void;
}

/** The custom moment field's id. */
const CUSTOM_FIELD_ID = 'pause-notifications-custom';

/** The choices inside the dialog, mounted fresh on each open so the presets read the current time. */
const PauseForm: React.FC<Omit<PauseNotificationsDialogProps, 'open'>> = ({
  control,
  workingHours,
  onClose,
}) => {
  const [now] = useState(() => new Date());
  const zone = viewerTimezone();
  const presets = pausePresets(workingHours, now, zone);
  const [custom, setCustom] = useState(() =>
    toLocalInput(presets[1]?.until ?? now, zone)
  );
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>('[data-pause-preset]')?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  const pick = (until: Date): void => {
    if (control.saving) return;
    void control.pause(until).then((kept) => {
      if (kept) onClose();
    });
  };

  const customMoment = fromLocalInput(custom, zone);
  const problem = reminderProblem(customMoment, now, PAUSE_MAX_DAYS);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    setTouched(true);
    if (problem !== null || customMoment === null) return;
    pick(customMoment);
  };

  return (
    <div className="space-y-3">
      {control.error !== null && (
        <ErrorAlert
          message={errorMessage(control.error, 'Could not save that change.')}
        />
      )}
      {control.pausedUntil !== null && (
        <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm text-text-muted">
          <LuBellOff aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            Paused until {reminderLabel(control.pausedUntil, zone)}.
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={control.saving}
            onClick={() => {
              void control.resume().then((kept) => {
                if (kept) onClose();
              });
            }}
          >
            <LuBell aria-hidden="true" className="h-3.5 w-3.5" />
            Resume now
          </Button>
        </div>
      )}
      <ul className="flex flex-col gap-1">
        {presets.map((preset) => (
          <li key={preset.id}>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-between"
              data-pause-preset=""
              disabled={control.saving}
              onClick={() => {
                pick(preset.until);
              }}
            >
              <span className="flex items-center gap-2">
                <LuBellOff aria-hidden="true" className="h-3.5 w-3.5" />
                {preset.label}
              </span>
              <span className="text-text-faint">
                {reminderLabel(preset.until, zone)}
              </span>
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="space-y-2 border-t border-line pt-3"
        onSubmit={submit}
        noValidate
      >
        <Field
          id={CUSTOM_FIELD_ID}
          label="Until a custom date and time"
          type="datetime-local"
          value={custom}
          aria-invalid={touched && problem !== null}
          hint={touched && problem !== null ? problem : `Times are in ${zone}.`}
          onChange={(event) => {
            setCustom(event.target.value);
          }}
          onBlur={() => {
            setTouched(true);
          }}
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={control.saving || problem !== null}
          >
            {control.saving ? 'Saving' : 'Pause'}
          </Button>
        </div>
      </form>
    </div>
  );
};

/** The "Pause notifications" modal. */
export const PauseNotificationsDialog: React.FC<
  PauseNotificationsDialogProps
> = ({ open, ...props }) => (
  <Dialog
    open={open}
    onClose={props.onClose}
    title="Pause notifications"
    description="Email and desktop notifications wait until the time you pick. Your inbox still fills, and held emails arrive as one digest when the pause ends."
    size="sm"
  >
    {open && <PauseForm {...props} />}
  </Dialog>
);

export default PauseNotificationsDialog;
