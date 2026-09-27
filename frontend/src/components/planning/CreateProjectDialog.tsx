/**
 * The new project dialog: the project's icon and colour, a large name field,
 * a summary, and a footer of property chips for status, health, priority,
 * lead, members, teams and dates, the way a new issue is written. Cmd or Ctrl
 * and Enter creates it from anywhere in the dialog.
 */

import React, { useState } from 'react';
import { LuCalendar, LuCalendarCheck } from 'react-icons/lu';
import { createProject } from '../../api/planning';
import { usePlanningTeamLists } from '../../hooks/usePlanningTeamLists';
import { errorMessage } from '../../lib/errors';
import type {
  IssuePriority,
  ProjectHealth,
  ProjectIconName,
  ProjectRead,
  ProjectStatus,
  TeamRead,
} from '../../types/Api';
import { DatePicker, PriorityPicker } from '../issues/PropertyPickers';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import {
  HealthPicker,
  LeadPicker,
  MembersPicker,
  ProjectLookPicker,
  ProjectStatusPicker,
  TeamsPicker,
} from './ProjectPickers';

/** Props for CreateProjectDialog: where it files the project and what to preset. */
export interface CreateProjectDialogProps {
  workspaceId: string;
  /** The teams a project may be put on: those the caller can write in. */
  teams: TeamRead[];
  /** The teams the new project starts on. */
  initialTeamIds: string[];
  initialStatus?: ProjectStatus;
  onClose: () => void;
  onCreated: (project: ProjectRead) => void;
}

/** The dialog that creates a project. */
export const CreateProjectDialog: React.FC<CreateProjectDialogProps> = ({
  workspaceId,
  teams,
  initialTeamIds,
  initialStatus = 'planned',
  onClose,
  onCreated,
}) => {
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [status, setStatus] = useState<ProjectStatus>(initialStatus);
  const [icon, setIcon] = useState<ProjectIconName | null>(null);
  const [color, setColor] = useState<string | null>(null);
  const [health, setHealth] = useState<ProjectHealth | null>(null);
  const [priority, setPriority] = useState<IssuePriority>('none');
  const [leadId, setLeadId] = useState<string | null>(null);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [teamIds, setTeamIds] = useState<string[]>(initialTeamIds);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [targetDate, setTargetDate] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { people } = usePlanningTeamLists(workspaceId, teamIds);

  const dateError =
    startDate !== null && targetDate !== null && targetDate < startDate
      ? 'The target date cannot fall before the start date.'
      : null;
  const canCreate =
    name.trim() !== '' && teamIds.length > 0 && dateError === null;

  const submit = (): void => {
    if (!canCreate || isSaving) return;
    setIsSaving(true);
    setError(null);
    createProject(workspaceId, {
      team_ids: teamIds,
      name: name.trim(),
      description: summary.trim() === '' ? null : summary.trim(),
      lead_id: leadId,
      start_date: startDate,
      target_date: targetDate,
      status,
      icon,
      color,
      health,
      priority,
      member_ids: memberIds,
    }).then(
      (project) => {
        setIsSaving(false);
        onCreated(project);
      },
      (failure: unknown) => {
        setIsSaving(false);
        setError(failure);
      }
    );
  };

  return (
    <Dialog open title="New project" size="lg" hideTitle onClose={onClose}>
      <div
        className="space-y-3"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      >
        <div className="flex items-center gap-2">
          <ProjectLookPicker
            icon={icon}
            color={color}
            className="h-7 w-7 [&>svg]:h-4 [&>svg]:w-4"
            onChange={(patch) => {
              if (patch.icon !== undefined) setIcon(patch.icon);
              if (patch.color !== undefined) setColor(patch.color);
            }}
          />
          <p className="text-xs font-medium text-text-muted">New project</p>
        </div>
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not create that project.')}
          />
        )}
        <input
          aria-label="Project name"
          placeholder="Project name"
          autoFocus
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          className="w-full bg-transparent text-xl font-semibold text-text placeholder:text-text-faint focus:outline-none"
        />
        <textarea
          aria-label="Summary"
          placeholder="Add a short summary..."
          rows={3}
          value={summary}
          onChange={(event) => {
            setSummary(event.target.value);
          }}
          className="w-full resize-none bg-transparent text-sm text-text placeholder:text-text-faint focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <ProjectStatusPicker
            variant="chip"
            value={status}
            onChange={setStatus}
          />
          <HealthPicker variant="chip" value={health} onChange={setHealth} />
          <PriorityPicker
            variant="chip"
            value={priority}
            onChange={setPriority}
          />
          <LeadPicker
            variant="chip"
            value={leadId}
            people={people}
            onChange={setLeadId}
          />
          <MembersPicker
            variant="chip"
            value={memberIds}
            people={people}
            onChange={setMemberIds}
          />
          <TeamsPicker
            variant="chip"
            value={teamIds}
            teams={teams}
            onChange={setTeamIds}
          />
          <DatePicker
            variant="chip"
            field="Start date"
            value={startDate}
            onChange={setStartDate}
            icon={<LuCalendar className="h-3.5 w-3.5" />}
            {...(targetDate === null ? {} : { max: targetDate })}
          />
          <DatePicker
            variant="chip"
            field="Target date"
            value={targetDate}
            onChange={setTargetDate}
            icon={<LuCalendarCheck className="h-3.5 w-3.5" />}
            {...(startDate === null ? {} : { min: startDate })}
          />
        </div>
        <ErrorAlert message={dateError} />
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
            {isSaving ? 'Creating' : 'Create project'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};

export default CreateProjectDialog;
