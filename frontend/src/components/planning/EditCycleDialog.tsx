/**
 * "Edit cycle...", Linear's dialog for a cycle's name, goal and dates. A date
 * already behind today is fixed, so its field is disabled, and no date may
 * be moved behind today, so both fields refuse earlier days. The server has
 * the last word: its 409 when an edit would collide with the next or previous
 * cycle, and its 422 when a date would rewrite the past, show in the dialog
 * and keep it open.
 *
 * Only the fields that changed are sent, and the caller is told what they
 * were before so the save can be undone.
 */

import React, { useState } from 'react';
import { cycleTitle } from '../../lib/cycleBreakdown';
import { errorMessage } from '../../lib/errors';
import { isoDate } from '../../lib/propertyOptions';
import { validateCycleDates } from '../../lib/validation';
import { cycleEditPatch, type CycleEdit } from '../../lib/planningModel';
import type { CycleRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import Field from '../ui/field';

/** Props for EditCycleDialog: the cycle and how to save an edit to it. */
export interface EditCycleDialogProps {
  cycle: CycleRead;
  /** Sends the changed fields; `before` holds what they were, for an undo. */
  onSave: (patch: CycleEdit, before: CycleEdit) => Promise<unknown>;
  onClose: () => void;
  /** Today as `YYYY-MM-DD`, the earliest day a date may move to. */
  today?: string;
}

/** The dialog behind a cycle menu's "Edit cycle..." item. */
export const EditCycleDialog: React.FC<EditCycleDialogProps> = ({
  cycle,
  onSave,
  onClose,
  today = isoDate(new Date()),
}) => {
  const [name, setName] = useState(cycleTitle(cycle));
  const [goal, setGoal] = useState(cycle.goal ?? '');
  const [startDate, setStartDate] = useState(cycle.start_date);
  const [endDate, setEndDate] = useState(cycle.end_date);
  const [failure, setFailure] = useState<unknown>(null);
  const [isSaving, setIsSaving] = useState(false);

  const startFixed = cycle.start_date < today;
  const endFixed = cycle.end_date < today;
  const dateError =
    validateCycleDates(startDate, endDate) ??
    (!startFixed && startDate !== '' && startDate < today
      ? 'The start date cannot move into the past.'
      : !endFixed && endDate !== '' && endDate < today
        ? 'The end date cannot be before today.'
        : null);
  const draft = {
    name: name === cycleTitle(cycle) ? cycle.name : name,
    goal,
    start_date: startDate,
    end_date: endDate,
  };
  const { patch, before } = cycleEditPatch(cycle, draft);
  const changed = Object.keys(patch).length > 0;
  const canSave =
    changed && startDate !== '' && endDate !== '' && dateError === null;

  const save = (): void => {
    setIsSaving(true);
    setFailure(null);
    onSave(patch, before)
      .then(() => {
        onClose();
      })
      .catch((error: unknown) => {
        setFailure(error);
      })
      .finally(() => {
        setIsSaving(false);
      });
  };

  return (
    <Dialog open title="Edit cycle" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave && !isSaving) save();
        }}
      >
        {failure !== null && (
          <ErrorAlert
            message={errorMessage(failure, 'Could not save that cycle.')}
          />
        )}
        <Field
          id="edit-cycle-name"
          label="Name"
          placeholder={cycleTitle({ ...cycle, name: '' })}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <Field
          id="edit-cycle-goal"
          label="Goal"
          placeholder="Optional"
          value={goal}
          onChange={(event) => {
            setGoal(event.target.value);
          }}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="edit-cycle-start"
            label="Start date"
            type="date"
            value={startDate}
            min={startFixed ? undefined : today}
            max={endDate === '' ? undefined : endDate}
            disabled={startFixed}
            {...(startFixed ? { hint: 'The cycle has started.' } : {})}
            onChange={(event) => {
              setStartDate(event.target.value);
            }}
          />
          <Field
            id="edit-cycle-end"
            label="End date"
            type="date"
            value={endDate}
            min={endFixed ? undefined : startDate > today ? startDate : today}
            disabled={endFixed}
            {...(endFixed ? { hint: 'The cycle has ended.' } : {})}
            onChange={(event) => {
              setEndDate(event.target.value);
            }}
          />
        </div>
        <ErrorAlert message={dateError} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={isSaving || !canSave}
          >
            {isSaving ? 'Saving' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

export default EditCycleDialog;
