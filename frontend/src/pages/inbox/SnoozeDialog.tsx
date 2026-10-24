/**
 * The inbox's snooze dialog, opened with H or a row's snooze button. It lists
 * the presets with the moment each lands on, then a custom date and time read
 * on the viewer's own clock, the same field and checks "Remind me" uses, held
 * to the server's 90 day bound. A row already snoozed offers to unsnooze it
 * now at the top.
 */

import React, { useEffect, useState } from 'react';
import { LuBellRing, LuClock } from 'react-icons/lu';
import Button from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import Field from '../../components/ui/field';
import {
  fromLocalInput,
  reminderLabel,
  reminderProblem,
  toLocalInput,
} from '../../lib/reminders';
import { viewerTimezone } from '../../lib/viewerTimezone';
import { SNOOZE_MAX_DAYS, SNOOZE_PRESETS } from './snooze';

/** Props for SnoozeDialog. */
export interface SnoozeDialogProps {
  open: boolean;
  /** What comes back, named in the description. */
  subject: string;
  /** Whether the row is snoozed now, which offers "Unsnooze now". */
  snoozed: boolean;
  onSnooze: (until: Date) => void;
  onUnsnooze: () => void;
  onClose: () => void;
}

/** The custom moment field's id. */
const CUSTOM_FIELD_ID = 'snooze-custom';

/** The choices inside the dialog, mounted fresh on each open so the presets read the current time. */
const SnoozeForm: React.FC<Omit<SnoozeDialogProps, 'open' | 'subject'>> = ({
  snoozed,
  onSnooze,
  onUnsnooze,
  onClose,
}) => {
  const [now] = useState(() => new Date());
  const zone = viewerTimezone();
  const presets = SNOOZE_PRESETS.map((preset) => ({
    ...preset,
    at: preset.until(now),
  }));
  const [custom, setCustom] = useState(() =>
    toLocalInput(presets.find((one) => one.id === 'tomorrow')?.at ?? now, zone)
  );
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>('[data-snooze-preset]')
        ?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  const customMoment = fromLocalInput(custom, zone);
  const problem = reminderProblem(customMoment, new Date(), SNOOZE_MAX_DAYS);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    setTouched(true);
    if (problem !== null || customMoment === null) return;
    onSnooze(customMoment);
  };

  return (
    <div className="space-y-3">
      <ul className="flex flex-col gap-1">
        {snoozed ? (
          <li>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              data-snooze-preset=""
              onClick={onUnsnooze}
            >
              <LuBellRing className="h-3.5 w-3.5" aria-hidden="true" />
              Unsnooze now
            </Button>
          </li>
        ) : null}
        {presets.map((preset) => (
          <li key={preset.id}>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-between"
              data-snooze-preset=""
              onClick={() => {
                onSnooze(preset.until(new Date()));
              }}
            >
              <span className="flex items-center gap-2">
                <LuClock className="h-3.5 w-3.5" aria-hidden="true" />
                {preset.label}
              </span>
              <span className="text-text-faint">
                {reminderLabel(preset.at, zone)}
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
          label="Custom date and time"
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
            disabled={problem !== null}
          >
            Snooze
          </Button>
        </div>
      </form>
    </div>
  );
};

/** The "Snooze notification" modal. */
export const SnoozeDialog: React.FC<SnoozeDialogProps> = ({
  open,
  subject,
  ...props
}) => (
  <Dialog
    open={open}
    onClose={props.onClose}
    title="Snooze notification"
    description={`${subject} comes back unread at the time you pick.`}
    size="sm"
  >
    {open && <SnoozeForm {...props} />}
  </Dialog>
);

export default SnoozeDialog;
