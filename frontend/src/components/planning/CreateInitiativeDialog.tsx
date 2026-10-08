/**
 * The new initiative dialog: a large name field, a summary, and a footer of
 * property chips for status, owner and target date, the way a new project is
 * written. Cmd or Ctrl and Enter creates it from anywhere in the dialog.
 */

import React, { useState } from 'react';
import { LuCalendarCheck } from 'react-icons/lu';
import { createInitiative } from '../../api/initiatives';
import { errorMessage } from '../../lib/errors';
import type { Assignable } from '../../lib/issuePeople';
import type { InitiativeRead, InitiativeStatus } from '../../types/Api';
import { DatePicker } from '../issues/PropertyPickers';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import { InitiativeStatusPicker, LeadPicker } from './ProjectPickers';

/** Props for CreateInitiativeDialog. */
export interface CreateInitiativeDialogProps {
  workspaceId: string;
  /** The workspace members an owner is picked from. */
  people: Assignable[];
  /** The owner the initiative starts with, the creator by default. */
  initialOwnerId: string | null;
  onClose: () => void;
  onCreated: (initiative: InitiativeRead) => void;
}

/** The dialog that creates an initiative. */
export const CreateInitiativeDialog: React.FC<CreateInitiativeDialogProps> = ({
  workspaceId,
  people,
  initialOwnerId,
  onClose,
  onCreated,
}) => {
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [status, setStatus] = useState<InitiativeStatus>('planned');
  const [ownerId, setOwnerId] = useState<string | null>(initialOwnerId);
  const [targetDate, setTargetDate] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const canCreate = name.trim() !== '';

  const submit = (): void => {
    if (!canCreate || isSaving) return;
    setIsSaving(true);
    setError(null);
    createInitiative(workspaceId, {
      name: name.trim(),
      description: summary.trim() === '' ? null : summary.trim(),
      owner_id: ownerId,
      status,
      target_date: targetDate,
    }).then(
      (initiative) => {
        setIsSaving(false);
        onCreated(initiative);
      },
      (failure: unknown) => {
        setIsSaving(false);
        setError(failure);
      }
    );
  };

  return (
    <Dialog open title="New initiative" size="lg" hideTitle onClose={onClose}>
      <div
        className="space-y-3"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      >
        <p className="text-xs font-medium text-text-muted">New initiative</p>
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not create that initiative.')}
          />
        )}
        <input
          aria-label="Initiative name"
          placeholder="Initiative name"
          autoFocus
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          className="w-full bg-transparent text-xl font-semibold text-text placeholder:text-text-faint focus:outline-none"
        />
        <textarea
          aria-label="Summary"
          placeholder="Add a short summary of the goal..."
          rows={3}
          value={summary}
          onChange={(event) => {
            setSummary(event.target.value);
          }}
          className="w-full resize-none bg-transparent text-sm text-text placeholder:text-text-faint focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <InitiativeStatusPicker
            variant="chip"
            value={status}
            onChange={setStatus}
          />
          <LeadPicker
            variant="chip"
            field="Owner"
            value={ownerId}
            people={people}
            onChange={setOwnerId}
          />
          <DatePicker
            variant="chip"
            field="Target date"
            value={targetDate}
            onChange={setTargetDate}
            icon={<LuCalendarCheck className="h-3.5 w-3.5" />}
          />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canCreate || isSaving}
            onClick={submit}
          >
            {isSaving ? 'Creating' : 'Create initiative'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};

export default CreateInitiativeDialog;
