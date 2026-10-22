/**
 * "Remind me": picks the moment the caller wants this issue back in their
 * inbox. The presets are later today, tomorrow morning and next week, and a
 * custom date and time is read on the viewer's own clock, the timezone on their
 * profile. A reminder already set shows at the top with a way to cancel it, and
 * picking a new moment replaces it. It opens from the issue menu, the command
 * palette and H.
 */

import React, { useEffect, useState } from 'react';
import { LuBellOff, LuClock } from 'react-icons/lu';
import type { IssueReminder } from '../../hooks/useIssueReminder';
import {
  fromLocalInput,
  reminderLabel,
  reminderPresets,
  reminderProblem,
  toLocalInput,
} from '../../lib/reminders';
import { viewerTimezone } from '../../lib/viewerTimezone';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import Field from '../ui/field';

/** Props for RemindMeDialog. */
export interface RemindMeDialogProps {
  open: boolean;
  /** The issue's key, named in the description. */
  issueKey: string;
  reminder: IssueReminder;
  onClose: () => void;
}

/** The custom moment field's id. */
const CUSTOM_FIELD_ID = 'remind-me-custom';

/** The choices inside the dialog, mounted fresh on each open so the presets read the current time. */
const RemindMeForm: React.FC<
  Omit<RemindMeDialogProps, 'open' | 'issueKey'>
> = ({ reminder, onClose }) => {
  const [now] = useState(() => new Date());
  const zone = viewerTimezone();
  const presets = reminderPresets(now, zone);
  const [custom, setCustom] = useState(() =>
    toLocalInput(presets[0]?.at ?? now, zone)
  );
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>('[data-remind-preset]')
        ?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  const pick = (moment: Date): void => {
    if (saving) return;
    setSaving(true);
    void reminder.set(moment).then((saved) => {
      setSaving(false);
      if (saved) onClose();
    });
  };

  const customMoment = fromLocalInput(custom, zone);
  const problem = reminderProblem(customMoment);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    setTouched(true);
    if (problem !== null || customMoment === null) return;
    pick(customMoment);
  };

  const pending = reminder.reminder;

  return (
    <div className="space-y-3">
      {pending !== null && (
        <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm text-text-muted">
          <LuClock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            Reminder set for {reminderLabel(pending.remind_at, zone)}.
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              reminder.cancel();
              onClose();
            }}
          >
            <LuBellOff aria-hidden="true" className="h-3.5 w-3.5" />
            Cancel reminder
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
              data-remind-preset=""
              disabled={saving}
              onClick={() => {
                pick(preset.at);
              }}
            >
              <span className="flex items-center gap-2">
                <LuClock aria-hidden="true" className="h-3.5 w-3.5" />
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
            disabled={saving || problem !== null}
          >
            {saving ? 'Saving' : 'Set reminder'}
          </Button>
        </div>
      </form>
    </div>
  );
};

/** The "Remind me" modal. */
export const RemindMeDialog: React.FC<RemindMeDialogProps> = ({
  open,
  issueKey,
  ...props
}) => (
  <Dialog
    open={open}
    onClose={props.onClose}
    title="Remind me"
    description={`${issueKey} comes back to your inbox at the time you pick.`}
    size="sm"
  >
    {open && <RemindMeForm {...props} />}
  </Dialog>
);

export default RemindMeDialog;
