/**
 * The list and form that keep a set of project templates, shared by a team's
 * settings and the workspace's. A project template is a name, the project
 * fields it fills, its dates as days after the project is created, and the
 * milestones and issues a project made from it starts with, as in Linear.
 *
 * An issue can sit under a milestone of the template and under an issue
 * listed before it, which makes it a sub-issue. Rows reference each other by
 * a key made here, so a reference holds while the rows are edited. Templates
 * a team inherits are listed beneath its own, read only.
 */

import React, { useId, useState } from 'react';
import {
  LuArrowDown,
  LuArrowUp,
  LuPencil,
  LuPlus,
  LuTrash2,
  LuX,
} from 'react-icons/lu';
import { errorMessage } from '../../lib/errors';
import type { Assignable } from '../../lib/issuePeople';
import { TEMPLATE_GROUPS } from '../../lib/issueTemplates';
import {
  nextTemplateKey,
  projectTemplateHint,
} from '../../lib/projectTemplates';
import type { EstimateOptions } from '../../lib/validation';
import type {
  EstimateScale,
  IssuePriority,
  LabelRead,
  ProjectIconName,
  ProjectStatus,
  ProjectTemplateFields,
  StatusRead,
  TemplateCreate,
  TemplateRead,
  TemplateUpdate,
} from '../../types/Api';
import {
  AssigneePicker,
  EstimatePicker,
  LabelsPicker,
  PriorityPicker,
  StatusPicker,
} from '../issues/PropertyPickers';
import {
  LeadPicker,
  MembersPicker,
  ProjectLookPicker,
  ProjectStatusPicker,
} from '../planning/ProjectPickers';
import { ErrorAlert } from '../ui/alert';
import { Badge } from '../ui/badge';
import Button, { IconButton } from '../ui/button';
import { Input, Textarea } from '../ui/input';
import Label from '../ui/label';
import { Select } from '../ui/select';
import type { TemplateEditorActions } from './TemplateEditor';

/** The furthest a template date may sit from the creation day. */
const OFFSET_MAX = 3650;

/** How many milestones one template adds. */
const MILESTONES_MAX = 25;

/** How many issues one template adds. */
const ISSUES_MAX = 50;

/** The lists the form's pickers choose from. People are team only. */
export interface ProjectTemplateEditorOptions {
  statuses: StatusRead[];
  labels: LabelRead[];
  people?: Assignable[];
  estimateScale?: EstimateScale;
  estimateOptions?: EstimateOptions;
}

/** Props for ProjectTemplateEditor. */
export interface ProjectTemplateEditorProps {
  templates: TemplateRead[];
  /** Whose templates these are: a team's own, or the workspace's. */
  scope: 'team' | 'workspace';
  canEdit: boolean;
  options: ProjectTemplateEditorOptions;
  actions: TemplateEditorActions;
  /** The template the team's new project dialog opens with. */
  defaultTemplateId?: string | null;
}

/** The form's working copy of one milestone. */
interface MilestoneRow {
  key: string;
  name: string;
  description: string;
  targetOffset: string;
}

/** The form's working copy of one issue. */
interface IssueRow {
  key: string;
  title: string;
  body: string;
  statusId: string | null;
  priority: IssuePriority;
  assigneeId: string | null;
  labelIds: string[];
  estimate: string | null;
  milestoneKey: string | null;
  parentKey: string | null;
}

/** The form's working copy of one project template. */
interface FormState {
  name: string;
  description: string;
  leadId: string | null;
  memberIds: string[];
  status: ProjectStatus | null;
  priority: IssuePriority;
  icon: ProjectIconName | null;
  color: string | null;
  startOffset: string;
  targetOffset: string;
  milestones: MilestoneRow[];
  issues: IssueRow[];
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  leadId: null,
  memberIds: [],
  status: null,
  priority: 'none',
  icon: null,
  color: null,
  startOffset: '',
  targetOffset: '',
  milestones: [],
  issues: [],
};

/** An offset as the number input holds it. */
const offsetText = (days: number | null | undefined): string =>
  days === null || days === undefined ? '' : String(days);

/** An offset as a write sends it, blank as null. */
const offsetOf = (text: string): number | null =>
  text.trim() === '' ? null : Number(text);

/** Whether a typed offset is blank or a whole number in range. */
const offsetValid = (text: string): boolean => {
  if (text.trim() === '') return true;
  const days = Number(text);
  return Number.isInteger(days) && days >= 0 && days <= OFFSET_MAX;
};

/** Text as a write sends it, blank as null. */
const textOf = (text: string): string | null =>
  text.trim() === '' ? null : text;

/** The form a saved template opens into. */
const formOf = (template: TemplateRead): FormState => {
  const blueprint = template.project ?? null;
  if (blueprint === null) return { ...EMPTY_FORM, name: template.name };
  return {
    name: template.name,
    description: blueprint.description ?? '',
    leadId: blueprint.lead_id ?? null,
    memberIds: blueprint.member_ids,
    status: blueprint.status ?? null,
    priority: blueprint.priority ?? 'none',
    icon: blueprint.icon ?? null,
    color: blueprint.color ?? null,
    startOffset: offsetText(blueprint.start_offset_days),
    targetOffset: offsetText(blueprint.target_offset_days),
    milestones: blueprint.milestones.map((milestone) => ({
      key: milestone.key,
      name: milestone.name,
      description: milestone.description ?? '',
      targetOffset: offsetText(milestone.target_offset_days),
    })),
    issues: blueprint.issues.map((issue) => ({
      key: issue.key,
      title: issue.title,
      body: issue.body ?? '',
      statusId: issue.status_id ?? null,
      priority: issue.priority ?? 'none',
      assigneeId: issue.assignee_id ?? null,
      labelIds: issue.label_ids ?? [],
      estimate: issue.estimate ?? null,
      milestoneKey: issue.milestone_key ?? null,
      parentKey: issue.parent_key ?? null,
    })),
  };
};

/** The blueprint a write sends, every field, so a cleared one is cleared. */
const blueprintOf = (form: FormState): ProjectTemplateFields => ({
  description: textOf(form.description),
  lead_id: form.leadId,
  member_ids: form.memberIds,
  status: form.status,
  priority: form.priority === 'none' ? null : form.priority,
  icon: form.icon,
  color: form.color,
  start_offset_days: offsetOf(form.startOffset),
  target_offset_days: offsetOf(form.targetOffset),
  milestones: form.milestones.map((row) => ({
    key: row.key,
    name: row.name.trim(),
    description: textOf(row.description),
    target_offset_days: offsetOf(row.targetOffset),
  })),
  issues: form.issues.map((row) => ({
    key: row.key,
    title: row.title.trim(),
    body: textOf(row.body),
    status_id: row.statusId,
    priority: row.priority === 'none' ? null : row.priority,
    assignee_id: row.assigneeId,
    label_ids: row.labelIds,
    estimate: row.estimate,
    milestone_key: row.milestoneKey,
    parent_key: row.parentKey,
  })),
});

/** Why the form cannot be saved yet, or null when it can. */
const formError = (form: FormState): string | null => {
  const offsets = [
    form.startOffset,
    form.targetOffset,
    ...form.milestones.map((row) => row.targetOffset),
  ];
  if (!offsets.every(offsetValid)) {
    return `Days after creation must be whole numbers from 0 to ${String(OFFSET_MAX)}.`;
  }
  const start = offsetOf(form.startOffset);
  const target = offsetOf(form.targetOffset);
  if (start !== null && target !== null && target < start) {
    return 'The target cannot come before the start.';
  }
  if (form.milestones.some((row) => row.name.trim() === '')) {
    return 'Every milestone needs a name.';
  }
  if (form.issues.some((row) => row.title.trim() === '')) {
    return 'Every issue needs a title.';
  }
  return null;
};

/** Props for ProjectTemplateForm. */
interface ProjectTemplateFormProps {
  initial: FormState;
  scope: 'team' | 'workspace';
  options: ProjectTemplateEditorOptions;
  submitLabel: string;
  onSubmit: (form: FormState) => Promise<unknown>;
  onCancel: () => void;
}

/** The name, project fields, milestones and issues of one template. */
const ProjectTemplateForm: React.FC<ProjectTemplateFormProps> = ({
  initial,
  scope,
  options,
  submitLabel,
  onSubmit,
  onCancel,
}) => {
  const id = useId();
  const [form, setForm] = useState<FormState>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (change: Partial<FormState>): void => {
    setForm((held) => ({ ...held, ...change }));
  };
  const team = scope === 'team';
  const people = options.people ?? [];
  const scale = options.estimateScale ?? 'off';
  const invalid = formError(form);
  const blocked = form.name.trim() === '' || invalid !== null || saving;

  const setMilestone = (key: string, change: Partial<MilestoneRow>): void => {
    setForm((held) => ({
      ...held,
      milestones: held.milestones.map((row) =>
        row.key === key ? { ...row, ...change } : row
      ),
    }));
  };
  const addMilestone = (): void => {
    setForm((held) => ({
      ...held,
      milestones: [
        ...held.milestones,
        {
          key: nextTemplateKey(
            'm',
            held.milestones.map((row) => row.key)
          ),
          name: '',
          description: '',
          targetOffset: '',
        },
      ],
    }));
  };
  const removeMilestone = (key: string): void => {
    setForm((held) => ({
      ...held,
      milestones: held.milestones.filter((row) => row.key !== key),
      issues: held.issues.map((row) =>
        row.milestoneKey === key ? { ...row, milestoneKey: null } : row
      ),
    }));
  };
  const moveMilestone = (index: number, by: number): void => {
    setForm((held) => {
      const target = index + by;
      if (target < 0 || target >= held.milestones.length) return held;
      const order = [...held.milestones];
      const [moved] = order.splice(index, 1);
      if (moved === undefined) return held;
      order.splice(target, 0, moved);
      return { ...held, milestones: order };
    });
  };
  const setIssue = (key: string, change: Partial<IssueRow>): void => {
    setForm((held) => ({
      ...held,
      issues: held.issues.map((row) =>
        row.key === key ? { ...row, ...change } : row
      ),
    }));
  };
  const addIssue = (): void => {
    setForm((held) => ({
      ...held,
      issues: [
        ...held.issues,
        {
          key: nextTemplateKey(
            'i',
            held.issues.map((row) => row.key)
          ),
          title: '',
          body: '',
          statusId: null,
          priority: 'none',
          assigneeId: null,
          labelIds: [],
          estimate: null,
          milestoneKey: null,
          parentKey: null,
        },
      ],
    }));
  };
  const removeIssue = (key: string): void => {
    setForm((held) => ({
      ...held,
      issues: held.issues
        .filter((row) => row.key !== key)
        .map((row) =>
          row.parentKey === key ? { ...row, parentKey: null } : row
        ),
    }));
  };

  return (
    <form
      aria-label={submitLabel}
      className="space-y-3 rounded-md border border-line p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked) return;
        setSaving(true);
        setError(null);
        onSubmit(form)
          .catch((failure: unknown) => {
            setError(failure);
          })
          .finally(() => {
            setSaving(false);
          });
      }}
    >
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not save that template.')}
        />
      )}
      <div className="space-y-1">
        <Label htmlFor={`${id}-name`}>Template name</Label>
        <Input
          id={`${id}-name`}
          value={form.name}
          maxLength={80}
          placeholder="Feature launch"
          onChange={(event) => {
            set({ name: event.target.value });
          }}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-description`}>Project description</Label>
        <Textarea
          id={`${id}-description`}
          rows={3}
          value={form.description}
          placeholder="Goals, scope and how the work is shipped"
          onChange={(event) => {
            set({ description: event.target.value });
          }}
        />
      </div>
      <div
        role="group"
        aria-label="Project properties"
        className="flex flex-wrap items-center gap-1.5"
      >
        <ProjectLookPicker
          icon={form.icon}
          color={form.color}
          className="h-7 w-7 [&>svg]:h-4 [&>svg]:w-4"
          onChange={(patch) => {
            if (patch.icon !== undefined) set({ icon: patch.icon });
            if (patch.color !== undefined) set({ color: patch.color });
          }}
        />
        <ProjectStatusPicker
          variant="chip"
          value={form.status ?? 'planned'}
          onChange={(status) => {
            set({ status });
          }}
        />
        {form.status !== null && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              set({ status: null });
            }}
          >
            Default status
          </Button>
        )}
        <PriorityPicker
          variant="chip"
          value={form.priority}
          onChange={(priority) => {
            set({ priority });
          }}
        />
        {team && (
          <LeadPicker
            variant="chip"
            value={form.leadId}
            people={people}
            onChange={(leadId) => {
              set({ leadId });
            }}
          />
        )}
        {team && (
          <MembersPicker
            variant="chip"
            value={form.memberIds}
            people={people}
            onChange={(memberIds) => {
              set({ memberIds });
            }}
          />
        )}
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="w-40 space-y-1">
          <Label htmlFor={`${id}-start`}>Start, days after creation</Label>
          <Input
            id={`${id}-start`}
            type="number"
            min={0}
            max={OFFSET_MAX}
            step={1}
            value={form.startOffset}
            placeholder="No start date"
            onChange={(event) => {
              set({ startOffset: event.target.value });
            }}
          />
        </div>
        <div className="w-40 space-y-1">
          <Label htmlFor={`${id}-target`}>Target, days after creation</Label>
          <Input
            id={`${id}-target`}
            type="number"
            min={0}
            max={OFFSET_MAX}
            step={1}
            value={form.targetOffset}
            placeholder="No target date"
            onChange={(event) => {
              set({ targetOffset: event.target.value });
            }}
          />
        </div>
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-text-muted">Milestones</p>
          <Button
            size="sm"
            variant="ghost"
            disabled={form.milestones.length >= MILESTONES_MAX}
            onClick={addMilestone}
          >
            <LuPlus aria-hidden="true" className="h-3.5 w-3.5" />
            Add milestone
          </Button>
        </div>
        {form.milestones.length === 0 ? (
          <p className="text-xs text-text-faint">No milestones.</p>
        ) : (
          <ol aria-label="Template milestones" className="space-y-2">
            {form.milestones.map((row, index) => {
              const number = String(index + 1);
              return (
                <li
                  key={row.key}
                  className="space-y-1.5 rounded-md border border-line p-2"
                >
                  <div className="flex items-center gap-1.5">
                    <Input
                      aria-label={`Milestone ${number} name`}
                      value={row.name}
                      maxLength={120}
                      placeholder="Milestone name"
                      onChange={(event) => {
                        setMilestone(row.key, { name: event.target.value });
                      }}
                    />
                    <div className="w-24 shrink-0">
                      <Input
                        aria-label={`Milestone ${number} target, days after creation`}
                        type="number"
                        min={0}
                        max={OFFSET_MAX}
                        step={1}
                        value={row.targetOffset}
                        placeholder="Day"
                        onChange={(event) => {
                          setMilestone(row.key, {
                            targetOffset: event.target.value,
                          });
                        }}
                      />
                    </div>
                    <IconButton
                      size="sm"
                      label={`Move milestone ${number} up`}
                      disabled={index === 0}
                      onClick={() => {
                        moveMilestone(index, -1);
                      }}
                    >
                      <LuArrowUp className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      label={`Move milestone ${number} down`}
                      disabled={index === form.milestones.length - 1}
                      onClick={() => {
                        moveMilestone(index, 1);
                      }}
                    >
                      <LuArrowDown className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      label={`Remove milestone ${number}`}
                      onClick={() => {
                        removeMilestone(row.key);
                      }}
                    >
                      <LuX className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                  <Input
                    aria-label={`Milestone ${number} description`}
                    value={row.description}
                    placeholder="Description"
                    onChange={(event) => {
                      setMilestone(row.key, {
                        description: event.target.value,
                      });
                    }}
                  />
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-text-muted">Issues</p>
          <Button
            size="sm"
            variant="ghost"
            disabled={form.issues.length >= ISSUES_MAX}
            onClick={addIssue}
          >
            <LuPlus aria-hidden="true" className="h-3.5 w-3.5" />
            Add issue
          </Button>
        </div>
        {form.issues.length === 0 ? (
          <p className="text-xs text-text-faint">No issues.</p>
        ) : (
          <ol aria-label="Template issues" className="space-y-2">
            {form.issues.map((row, index) => {
              const number = String(index + 1);
              const earlier = form.issues.slice(0, index);
              return (
                <li
                  key={row.key}
                  className="space-y-1.5 rounded-md border border-line p-2"
                >
                  <div className="flex items-center gap-1.5">
                    <Input
                      aria-label={`Issue ${number} title`}
                      value={row.title}
                      placeholder="Issue title"
                      onChange={(event) => {
                        setIssue(row.key, { title: event.target.value });
                      }}
                    />
                    <IconButton
                      size="sm"
                      label={`Remove issue ${number}`}
                      onClick={() => {
                        removeIssue(row.key);
                      }}
                    >
                      <LuX className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                  <Textarea
                    aria-label={`Issue ${number} description`}
                    rows={2}
                    value={row.body}
                    placeholder="Description"
                    onChange={(event) => {
                      setIssue(row.key, { body: event.target.value });
                    }}
                  />
                  <div
                    role="group"
                    aria-label={`Issue ${number} properties`}
                    className="flex flex-wrap items-center gap-1.5"
                  >
                    <StatusPicker
                      variant="chip"
                      statuses={options.statuses}
                      value={row.statusId}
                      onChange={(statusId) => {
                        setIssue(row.key, { statusId });
                      }}
                    />
                    <PriorityPicker
                      variant="chip"
                      value={row.priority}
                      onChange={(priority) => {
                        setIssue(row.key, { priority });
                      }}
                    />
                    {team && (
                      <AssigneePicker
                        variant="chip"
                        people={people}
                        value={row.assigneeId}
                        onChange={(assigneeId) => {
                          setIssue(row.key, { assigneeId });
                        }}
                      />
                    )}
                    <LabelsPicker
                      variant="chip"
                      labels={options.labels}
                      value={row.labelIds}
                      onChange={(labelIds) => {
                        setIssue(row.key, { labelIds });
                      }}
                    />
                    {team && scale !== 'off' && (
                      <EstimatePicker
                        variant="chip"
                        scale={scale}
                        extended={options.estimateOptions?.extended ?? false}
                        allowZero={options.estimateOptions?.allowZero ?? false}
                        value={row.estimate}
                        onChange={(estimate) => {
                          setIssue(row.key, { estimate });
                        }}
                      />
                    )}
                    {form.milestones.length > 0 && (
                      <div className="w-44">
                        <Select
                          aria-label={`Issue ${number} milestone`}
                          value={row.milestoneKey ?? ''}
                          onChange={(event) => {
                            const picked = event.target.value;
                            setIssue(row.key, {
                              milestoneKey: picked === '' ? null : picked,
                            });
                          }}
                        >
                          <option value="">No milestone</option>
                          {form.milestones.map((milestone, position) => (
                            <option key={milestone.key} value={milestone.key}>
                              {milestone.name.trim() === ''
                                ? `Milestone ${String(position + 1)}`
                                : milestone.name}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}
                    {earlier.length > 0 && (
                      <div className="w-44">
                        <Select
                          aria-label={`Issue ${number} parent`}
                          value={row.parentKey ?? ''}
                          onChange={(event) => {
                            const picked = event.target.value;
                            setIssue(row.key, {
                              parentKey: picked === '' ? null : picked,
                            });
                          }}
                        >
                          <option value="">No parent issue</option>
                          {earlier.map((issue, position) => (
                            <option key={issue.key} value={issue.key}>
                              {issue.title.trim() === ''
                                ? `Issue ${String(position + 1)}`
                                : issue.title}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {form.name.trim() !== '' && <ErrorAlert message={invalid} />}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={blocked}>
          {saving ? 'Saving' : submitLabel}
        </Button>
      </div>
    </form>
  );
};

/** Lists and edits a set of project templates. */
export const ProjectTemplateEditor: React.FC<
  ProjectTemplateEditorProps
> = ({
  templates,
  scope,
  canEdit,
  options,
  actions,
  defaultTemplateId = null,
}) => {
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const own = templates.filter(
    (template) => scope === 'workspace' || template.scope === 'team'
  );
  const inherited = templates.filter(
    (template) => scope === 'team' && template.scope !== 'team'
  );

  const run = (write: Promise<unknown>): void => {
    setError(null);
    write.catch((failure: unknown) => {
      setError(failure);
    });
  };

  const move = (index: number, by: number): void => {
    const target = index + by;
    if (target < 0 || target >= own.length) return;
    const order = [...own];
    const [moved] = order.splice(index, 1);
    if (moved === undefined) return;
    order.splice(target, 0, moved);
    run(
      Promise.all(
        order
          .map((template, position) => ({ template, position }))
          .filter(({ template, position }) => template.position !== position)
          .map(({ template, position }) =>
            actions.update(template, { position })
          )
      )
    );
  };

  return (
    <div className="space-y-3">
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not change that template.')}
        />
      )}

      {own.length === 0 && editing !== 'new' && (
        <p className="text-sm text-text-muted">
          No project templates yet.
          {canEdit ? ' Add one to start new projects with a plan.' : ''}
        </p>
      )}

      {own.length > 0 && (
        <ul aria-label="Project templates" className="divide-y divide-line">
          {own.map((template, index) =>
            editing === template.id ? (
              <li key={template.id} className="py-2">
                <ProjectTemplateForm
                  initial={formOf(template)}
                  scope={scope}
                  options={options}
                  submitLabel="Save project template"
                  onCancel={() => {
                    setEditing(null);
                  }}
                  onSubmit={(form) => {
                    const body: TemplateUpdate = {
                      name: form.name.trim(),
                      project: blueprintOf(form),
                    };
                    return actions.update(template, body).then(() => {
                      setEditing(null);
                    });
                  }}
                />
              </li>
            ) : (
              <li
                key={template.id}
                className="flex min-h-10 items-center gap-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-sm text-text">
                    {template.name}
                    {template.id === defaultTemplateId && (
                      <Badge tone="accent">Default</Badge>
                    )}
                  </p>
                  <p className="truncate text-xs text-text-muted">
                    {projectTemplateHint(template.project) ??
                      'No milestones or issues'}
                  </p>
                </div>
                {canEdit &&
                  (confirming === template.id ? (
                    <div
                      role="alertdialog"
                      aria-label={`Delete ${template.name}?`}
                      className="flex items-center gap-2"
                    >
                      <span className="text-xs text-text-muted">
                        Delete this template?
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setConfirming(null);
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          setConfirming(null);
                          run(actions.remove(template));
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-0.5">
                      <IconButton
                        size="sm"
                        label={`Move ${template.name} up`}
                        disabled={index === 0}
                        onClick={() => {
                          move(index, -1);
                        }}
                      >
                        <LuArrowUp className="h-3.5 w-3.5" />
                      </IconButton>
                      <IconButton
                        size="sm"
                        label={`Move ${template.name} down`}
                        disabled={index === own.length - 1}
                        onClick={() => {
                          move(index, 1);
                        }}
                      >
                        <LuArrowDown className="h-3.5 w-3.5" />
                      </IconButton>
                      <IconButton
                        size="sm"
                        label={`Edit ${template.name}`}
                        onClick={() => {
                          setEditing(template.id);
                        }}
                      >
                        <LuPencil className="h-3.5 w-3.5" />
                      </IconButton>
                      <IconButton
                        size="sm"
                        label={`Delete ${template.name}`}
                        onClick={() => {
                          setConfirming(template.id);
                        }}
                      >
                        <LuTrash2 className="h-3.5 w-3.5" />
                      </IconButton>
                    </div>
                  ))}
              </li>
            )
          )}
        </ul>
      )}

      {canEdit &&
        (editing === 'new' ? (
          <ProjectTemplateForm
            initial={EMPTY_FORM}
            scope={scope}
            options={options}
            submitLabel="Create project template"
            onCancel={() => {
              setEditing(null);
            }}
            onSubmit={(form) => {
              const body: TemplateCreate = {
                kind: 'project',
                name: form.name.trim(),
                project: blueprintOf(form),
              };
              return actions.create(body).then(() => {
                setEditing(null);
              });
            }}
          />
        ) : (
          <Button
            size="sm"
            onClick={() => {
              setEditing('new');
            }}
          >
            New project template
          </Button>
        ))}

      {inherited.length > 0 && (
        <div className="space-y-1 pt-2">
          <p className="text-xs font-medium text-text-faint">Inherited</p>
          <ul
            aria-label="Inherited project templates"
            className="divide-y divide-line"
          >
            {inherited.map((template) => (
              <li
                key={template.id}
                className="flex min-h-9 items-center gap-2 py-1.5 text-sm"
              >
                <span className="min-w-0 flex-1 truncate text-text">
                  {template.name}
                </span>
                {template.id === defaultTemplateId && (
                  <Badge tone="accent">Default</Badge>
                )}
                <Badge>{TEMPLATE_GROUPS[template.scope]}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default ProjectTemplateEditor;
