/**
 * "Set status", as in Linear: an emoji and a line of text teammates see beside
 * your name, an away mark that puts a dot on your avatar and a note beside
 * work assigned to you, and when the status clears itself. The presets are On
 * vacation, Out sick, Focusing and In meetings, each with its own clear time.
 * A status belongs to the workspace it is set in. Notifications keep arriving
 * while away; pausing them is its own choice in the same menu.
 */

import React, { useEffect, useState } from 'react';
import type { MyStatus } from '../../hooks/useMyStatus';
import { errorMessage } from '../../lib/errors';
import {
  fromLocalInput,
  reminderProblem,
  toLocalInput,
} from '../../lib/reminders';
import {
  CLEAR_AFTER_LABELS,
  STATUS_PRESETS,
  STATUS_TEXT_MAX,
  clearAfterMoment,
  type ClearAfter,
  type StatusPreset,
} from '../../lib/userStatus';
import { viewerTimezone } from '../../lib/viewerTimezone';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Checkbox from '../ui/checkbox';
import Dialog from '../ui/dialog';
import Field from '../ui/field';
import { SelectField } from '../ui/select';

/** Props for UserStatusDialog. */
export interface UserStatusDialogProps {
  open: boolean;
  control: MyStatus;
  onClose: () => void;
}

/** The "Clear after" choice that reads a custom date and time. */
const CUSTOM = 'custom';

/** Every "Clear after" value the dropdown offers. */
type ClearChoice = ClearAfter | typeof CUSTOM;

/** The furthest out a status may be set to clear, in days. */
const STATUS_MAX_DAYS = 365;

/** The dropdown's options, in order. */
const CLEAR_CHOICES: ClearChoice[] = [
  'never',
  '30m',
  '1h',
  '4h',
  'today',
  'week',
  CUSTOM,
];

/** How a choice reads in the dropdown. */
const choiceLabel = (choice: ClearChoice): string =>
  choice === CUSTOM ? 'Pick a date and time' : CLEAR_AFTER_LABELS[choice];

/** The form inside the dialog, mounted fresh on each open so it starts from the current status. */
const StatusForm: React.FC<Omit<UserStatusDialogProps, 'open'>> = ({
  control,
  onClose,
}) => {
  const zone = viewerTimezone();
  const [now] = useState(() => new Date());
  const current = control.status;
  const [emoji, setEmoji] = useState(current?.emoji ?? '');
  const [text, setText] = useState(current?.text ?? '');
  const [away, setAway] = useState(current?.away ?? false);
  const [clearAfter, setClearAfter] = useState<ClearChoice>(
    current?.until ? CUSTOM : 'never'
  );
  const [custom, setCustom] = useState(() =>
    toLocalInput(
      current?.until
        ? new Date(current.until)
        : (clearAfterMoment('today', now, zone) ?? now),
      zone
    )
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>('#user-status-text')?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  const customMoment = fromLocalInput(custom, zone);
  const customProblem =
    clearAfter === CUSTOM
      ? reminderProblem(customMoment, now, STATUS_MAX_DAYS)
      : null;
  const empty = emoji.trim() === '' && text.trim() === '';

  const pickPreset = (preset: StatusPreset): void => {
    setEmoji(preset.emoji);
    setText(preset.text);
    setAway(preset.away);
    setClearAfter(preset.clearAfter);
  };

  const until = (): Date | null =>
    clearAfter === CUSTOM
      ? customMoment
      : clearAfterMoment(clearAfter, new Date(), zone);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (control.saving || empty || customProblem !== null) return;
    const end = until();
    void control
      .save({
        emoji: emoji.trim(),
        text: text.trim(),
        away,
        until: end === null ? null : end.toISOString(),
      })
      .then((kept) => {
        if (kept) onClose();
      });
  };

  return (
    <form className="space-y-3" onSubmit={submit} noValidate>
      {control.error !== null && (
        <ErrorAlert
          message={errorMessage(control.error, 'Could not save your status.')}
        />
      )}
      <div className="flex items-end gap-2">
        <Field
          id="user-status-emoji"
          label="Emoji"
          className="w-16"
          value={emoji}
          maxLength={16}
          placeholder="💬"
          onChange={(event) => {
            setEmoji(event.target.value);
          }}
        />
        <Field
          id="user-status-text"
          label="Status"
          className="min-w-0 flex-1"
          value={text}
          maxLength={STATUS_TEXT_MAX}
          placeholder="What's your status?"
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </div>
      <ul className="flex flex-col gap-0.5" aria-label="Presets">
        {STATUS_PRESETS.map((preset) => (
          <li key={preset.id}>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-between"
              data-status-preset={preset.id}
              onClick={() => {
                pickPreset(preset);
              }}
            >
              <span className="flex items-center gap-2">
                <span aria-hidden="true">{preset.emoji}</span>
                {preset.text}
              </span>
              <span className="text-text-faint">
                {CLEAR_AFTER_LABELS[preset.clearAfter]}
              </span>
            </Button>
          </li>
        ))}
      </ul>
      <Checkbox
        label="Mark me as away"
        checked={away}
        onChange={(event) => {
          setAway(event.target.checked);
        }}
      />
      <SelectField
        id="user-status-clear-after"
        label="Clear after"
        value={clearAfter}
        onChange={(event) => {
          setClearAfter(event.target.value as ClearChoice);
        }}
      >
        {CLEAR_CHOICES.map((choice) => (
          <option key={choice} value={choice}>
            {choiceLabel(choice)}
          </option>
        ))}
      </SelectField>
      {clearAfter === CUSTOM && (
        <Field
          id="user-status-until"
          label="Clear at"
          type="datetime-local"
          value={custom}
          aria-invalid={customProblem !== null}
          hint={customProblem ?? `Times are in ${zone}.`}
          onChange={(event) => {
            setCustom(event.target.value);
          }}
        />
      )}
      <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
        {current !== null ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={control.saving}
            onClick={() => {
              void control.clear().then((kept) => {
                if (kept) onClose();
              });
            }}
          >
            Clear status
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={control.saving || empty || customProblem !== null}
          >
            {control.saving ? 'Saving' : 'Save status'}
          </Button>
        </div>
      </div>
    </form>
  );
};

/** The "Set status" modal. */
export const UserStatusDialog: React.FC<UserStatusDialogProps> = ({
  open,
  ...props
}) => (
  <Dialog
    open={open}
    onClose={props.onClose}
    title="Set status"
    description="Teammates in this workspace see it beside your name. Notifications keep arriving while you are away."
    size="sm"
  >
    {open && <StatusForm {...props} />}
  </Dialog>
);

export default UserStatusDialog;
