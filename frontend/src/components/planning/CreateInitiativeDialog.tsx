/**
 * The new initiative dialog: a large name field, a summary, and a footer of
 * property chips for status, owner, lead team, start and target date, the way a new project is
 * written. Cmd or Ctrl and Enter creates it from anywhere in the dialog.
 * Opened from a parent's page, it creates a sub-initiative of that parent.
 */

import React, { useState } from 'react';
import { LuCalendar, LuCalendarCheck } from 'react-icons/lu';
import { createInitiative } from '../../api/initiatives';
import { useOffline } from '../../hooks/useOffline';
import { isCoarse } from '../../lib/dateResolution';
import { errorMessage } from '../../lib/errors';
import type { Assignable } from '../../lib/issuePeople';
import type {
  DateResolution,
  InitiativeRead,
  InitiativeStatus,
  TeamRead,
} from '../../types/Api';
import PlanningDatePicker from './PlanningDatePicker';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import {
  InitiativeStatusPicker,
  LeadPicker,
  LeadTeamPicker,
} from './ProjectPickers';

/** Props for CreateInitiativeDialog. */
export interface CreateInitiativeDialogProps {
  workspaceId: string;
  /** The workspace members an owner is picked from. */
  people: Assignable[];
  /** The owner the initiative starts with, the creator by default. */
  initialOwnerId: string | null;
  /** The teams a lead team is picked from; none hides the team chip. */
  teams?: TeamRead[];
  /** The lead team the initiative starts with, such as the team the list is filtered to. */
  initialTeamId?: string | null;
  /** The parent a sub-initiative is created under, none for a top-level one. */
  parent?: { initiative_id: string; name: string } | null;
  onClose: () => void;
  onCreated: (initiative: InitiativeRead) => void;
}

/** The dialog that creates an initiative. */
export const CreateInitiativeDialog: React.FC<CreateInitiativeDialogProps> = ({
  workspaceId,
  people,
  initialOwnerId,
  teams = [],
  initialTeamId = null,
  parent = null,
  onClose,
  onCreated,
}) => {
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [status, setStatus] = useState<InitiativeStatus>('planned');
  const [ownerId, setOwnerId] = useState<string | null>(initialOwnerId);
  const [teamId, setTeamId] = useState<string | null>(initialTeamId);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [startResolution, setStartResolution] = useState<DateResolution | null>(
    null
  );
  const [targetDate, setTargetDate] = useState<string | null>(null);
  const [targetResolution, setTargetResolution] =
    useState<DateResolution | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const offline = useOffline();

  const canCreate = name.trim() !== '' && !offline;

  const submit = (): void => {
    if (!canCreate || isSaving) return;
    setIsSaving(true);
    setError(null);
    createInitiative(workspaceId, {
      name: name.trim(),
      description: summary.trim() === '' ? null : summary.trim(),
      owner_id: ownerId,
      ...(teamId === null ? {} : { team_id: teamId }),
      status,
      ...(startDate === null ? {} : { start_date: startDate }),
      ...(startDate !== null && isCoarse(startResolution)
        ? { start_date_resolution: startResolution }
        : {}),
      target_date: targetDate,
      ...(targetDate !== null && isCoarse(targetResolution)
        ? { target_date_resolution: targetResolution }
        : {}),
      ...(parent === null
        ? {}
        : { parent_initiative_id: parent.initiative_id }),
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
    <Dialog
      open
      title={parent === null ? 'New initiative' : 'New sub-initiative'}
      size="lg"
      hideTitle
      onClose={onClose}
    >
      <div
        className="space-y-3"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      >
        <p className="truncate text-xs font-medium text-text-muted">
          {parent === null
            ? 'New initiative'
            : `New sub-initiative in ${parent.name}`}
        </p>
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
          {teams.length > 0 && (
            <LeadTeamPicker
              variant="chip"
              value={teamId}
              teams={teams}
              onChange={setTeamId}
            />
          )}
          <PlanningDatePicker
            variant="chip"
            field="Start date"
            edge="start"
            value={startDate}
            resolution={startResolution}
            {...(targetDate === null ? {} : { max: targetDate })}
            onChange={(value, resolution) => {
              setStartDate(value);
              setStartResolution(resolution);
            }}
            icon={<LuCalendar className="h-3.5 w-3.5" />}
          />
          <PlanningDatePicker
            variant="chip"
            field="Target date"
            edge="end"
            value={targetDate}
            resolution={targetResolution}
            {...(startDate === null ? {} : { min: startDate })}
            onChange={(value, resolution) => {
              setTargetDate(value);
              setTargetResolution(resolution);
            }}
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
