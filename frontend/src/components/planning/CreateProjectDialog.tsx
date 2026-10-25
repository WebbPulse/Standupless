/**
 * The new project dialog: the project's icon and colour, a large name field,
 * a summary, and a footer of property chips for status, health, priority,
 * lead, members, teams and dates, the way a new issue is written. Cmd or Ctrl
 * and Enter creates it from anywhere in the dialog.
 *
 * A project template prefills the fields and adds its milestones and issues
 * once the project exists. The first team's default is applied as the dialog
 * opens, and the header chip switches templates or goes back to none. The
 * fields stay editable; one still holding what the template wrote is left out
 * of the create, so the server fills it, dates counted from its own today.
 */

import React, { useState } from 'react';
import { LuCalendar, LuCalendarCheck } from 'react-icons/lu';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { createProject, updateProject } from '../../api/planning';
import { listTeamTemplates } from '../../api/templates';
import { usePlanningTeamLists } from '../../hooks/usePlanningTeamLists';
import { isCoarse } from '../../lib/dateResolution';
import { errorMessage } from '../../lib/errors';
import type { ProjectMove } from '../../lib/projectList';
import { showToast } from '../../lib/toast';
import {
  projectTemplateHint,
  projectTemplatePrefill,
  type ProjectTemplatePrefill,
} from '../../lib/projectTemplates';
import type {
  DateResolution,
  IssuePriority,
  ProjectCreate,
  ProjectHealth,
  ProjectIconName,
  ProjectRead,
  ProjectStatus,
  SkippedTemplateIssueRead,
  TeamRead,
  TemplateListRead,
  TemplateRead,
} from '../../types/Api';
import PlanningDatePicker from './PlanningDatePicker';
import { PriorityPicker } from '../issues/PropertyPickers';
import { TemplatePicker } from '../issues/TemplatePicker';
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
  /** The workspace status the project starts in, inside `initialStatus`. */
  initialStatusId?: string;
  /**
   * Fields the project starts with, such as the health, priority, lead or
   * initiative of the board column it is created in.
   */
  preset?: ProjectMove;
  onClose: () => void;
  onCreated: (project: ProjectRead) => void;
}

/** How often the dialog re-reads the teams' project templates while open. */
const TEMPLATES_POLL_MS = 60000;

/** The template the form was filled from and what it wrote. */
interface AppliedTemplate {
  id: string;
  fill: ProjectTemplatePrefill;
}

/**
 * The project templates the chosen teams offer, each once in the first
 * team's order, and the first team's default.
 */
const listProjectTemplates = async (
  workspaceId: string,
  teamIds: readonly string[],
  signal?: AbortSignal
): Promise<TemplateListRead> => {
  const lists = await Promise.all(
    teamIds.map((teamId) =>
      listTeamTemplates(workspaceId, teamId, signal, 'project')
    )
  );
  const seen = new Set<string>();
  const templates: TemplateRead[] = [];
  for (const list of lists) {
    for (const template of list.templates) {
      if (seen.has(template.id)) continue;
      seen.add(template.id);
      templates.push(template);
    }
  }
  return {
    templates,
    default_template_id: lists[0]?.default_template_id ?? null,
  };
};

/** Whether two id lists hold the same ids in the same order. */
const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

/**
 * Raises a notice naming the template issues the server left out of a new
 * project, so a skipped issue is never lost without a word.
 */
const announceSkipped = (
  skipped: readonly SkippedTemplateIssueRead[]
): void => {
  const first = skipped[0];
  if (first === undefined) return;
  const titles = skipped.map((row) => row.title).join(', ');
  const message =
    skipped.length === 1
      ? `Left out template issue "${first.title}": ${first.reason}`
      : `Left out ${String(skipped.length)} template issues: ${titles}`;
  showToast(message, 'error');
};

/** The dialog that creates a project. */
export const CreateProjectDialog: React.FC<CreateProjectDialogProps> = ({
  workspaceId,
  teams,
  initialTeamIds,
  initialStatus = 'planned',
  initialStatusId,
  preset = {},
  onClose,
  onCreated,
}) => {
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [status, setStatus] = useState<ProjectStatus>(initialStatus);
  const [statusId, setStatusId] = useState<string | undefined>(initialStatusId);
  const [icon, setIcon] = useState<ProjectIconName | null>(null);
  const [color, setColor] = useState<string | null>(null);
  const [health, setHealth] = useState<ProjectHealth | null>(
    preset.health ?? null
  );
  const [priority, setPriority] = useState<IssuePriority>(
    preset.priority ?? 'none'
  );
  const [leadId, setLeadId] = useState<string | null>(preset.lead_id ?? null);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [teamIds, setTeamIds] = useState<string[]>(initialTeamIds);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [targetDate, setTargetDate] = useState<string | null>(null);
  const [startResolution, setStartResolution] = useState<DateResolution | null>(
    null
  );
  const [targetResolution, setTargetResolution] =
    useState<DateResolution | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [applied, setApplied] = useState<AppliedTemplate | null>(null);
  const [pendingDefault, setPendingDefault] = useState(true);
  const { people } = usePlanningTeamLists(workspaceId, teamIds);
  const auth = useQueryAuth();

  const { data: templateList } = usePolledQuery(
    ({ signal }) => listProjectTemplates(workspaceId, teamIds, signal),
    {
      intervalMs: TEMPLATES_POLL_MS,
      queryKey: ['project-templates', 'picker', ...teamIds],
      auth,
      enabled: teamIds.length > 0,
    }
  );
  const templates = templateList?.templates ?? [];
  const template =
    applied === null
      ? undefined
      : templates.find((item) => item.id === applied.id);
  const hint =
    template === undefined ? null : projectTemplateHint(template.project);

  const applyTemplate = (next: TemplateRead | null): void => {
    const fill: ProjectTemplatePrefill =
      next === null ? {} : projectTemplatePrefill(next);
    const written = applied?.fill.description ?? '';
    if (summary.trim() === '' || summary === written) {
      setSummary(fill.description ?? '');
    }
    setStatus(fill.status ?? initialStatus);
    setStatusId(fill.status === undefined ? initialStatusId : undefined);
    setPriority(fill.priority ?? preset.priority ?? 'none');
    setLeadId(fill.leadId ?? preset.lead_id ?? null);
    setMemberIds(fill.memberIds ?? []);
    setIcon(fill.icon ?? null);
    setColor(fill.color ?? null);
    setStartDate(fill.startDate ?? null);
    setTargetDate(fill.targetDate ?? null);
    setStartResolution(null);
    setTargetResolution(null);
    setApplied(next === null ? null : { id: next.id, fill });
  };

  if (pendingDefault && templateList !== null) {
    setPendingDefault(false);
    const preset = templateList.templates.find(
      (item) => item.id === templateList.default_template_id
    );
    if (preset !== undefined) applyTemplate(preset);
  }

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
    const body: ProjectCreate = {
      team_ids: teamIds,
      name: name.trim(),
      health,
    };
    const fill: ProjectTemplatePrefill =
      template === undefined || applied === null ? {} : applied.fill;
    const description = summary.trim() === '' ? null : summary.trim();
    if (fill.description !== description) body.description = description;
    if (fill.leadId !== leadId) body.lead_id = leadId;
    if (fill.startDate !== startDate) body.start_date = startDate;
    if (fill.targetDate !== targetDate) body.target_date = targetDate;
    if (startDate !== null && isCoarse(startResolution)) {
      body.start_date = startDate;
      body.start_date_resolution = startResolution;
    }
    if (targetDate !== null && isCoarse(targetResolution)) {
      body.target_date = targetDate;
      body.target_date_resolution = targetResolution;
    }
    if (fill.status !== status) body.status = status;
    if (statusId !== undefined && statusId !== status) {
      body.status = status;
      body.status_id = statusId;
    }
    if (fill.icon !== icon) body.icon = icon;
    if (fill.color !== color) body.color = color;
    if (fill.priority !== priority) body.priority = priority;
    if (fill.memberIds === undefined || !sameIds(fill.memberIds, memberIds)) {
      body.member_ids = memberIds;
    }
    if (template !== undefined) body.template_id = template.id;
    createProject(workspaceId, body).then(
      (project) => {
        announceSkipped(project.skipped_template_issues ?? []);
        const initiativeId = preset.initiative_id ?? null;
        if (initiativeId === null) {
          setIsSaving(false);
          onCreated(project);
          return;
        }
        updateProject(workspaceId, project.project_id, {
          initiative_id: initiativeId,
        }).then(
          (stored) => {
            setIsSaving(false);
            onCreated(stored);
          },
          (failure: unknown) => {
            setIsSaving(false);
            showToast(
              errorMessage(
                failure,
                'Created the project, but could not add it to the initiative.'
              ),
              'error'
            );
            onCreated(project);
          }
        );
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
          {templates.length > 0 && (
            <span className="ml-auto flex items-center gap-1">
              <TemplatePicker
                templates={templates}
                value={template?.id ?? null}
                onChange={applyTemplate}
              />
            </span>
          )}
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
            statusId={statusId}
            onChange={(category, id) => {
              setStatus(category);
              setStatusId(id);
            }}
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
          <PlanningDatePicker
            variant="chip"
            field="Start date"
            edge="start"
            value={startDate}
            resolution={startResolution}
            onChange={(value, resolution) => {
              setStartDate(value);
              setStartResolution(resolution);
            }}
            icon={<LuCalendar className="h-3.5 w-3.5" />}
            {...(targetDate === null ? {} : { max: targetDate })}
          />
          <PlanningDatePicker
            variant="chip"
            field="Target date"
            edge="end"
            value={targetDate}
            resolution={targetResolution}
            onChange={(value, resolution) => {
              setTargetDate(value);
              setTargetResolution(resolution);
            }}
            icon={<LuCalendarCheck className="h-3.5 w-3.5" />}
            {...(startDate === null ? {} : { min: startDate })}
          />
        </div>
        {hint !== null && <p className="text-xs text-text-muted">{hint}</p>}
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
