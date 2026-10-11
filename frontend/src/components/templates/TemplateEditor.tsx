/**
 * The list and form that keep a set of issue templates, shared by a team's
 * settings and the workspace's. A template is a name and whichever issue
 * fields it fills; anything left alone stays the team default when an issue
 * is created from it, as in Linear.
 *
 * Templates a team inherits from its parent team or the workspace are listed
 * beneath its own, read only, because they are kept where they are defined.
 * Order is the picker's order, so each own template moves up or down a place
 * and the new order is written back as positions.
 */

import React, { useState } from 'react';
import { LuArrowDown, LuArrowUp, LuPencil, LuTrash2 } from 'react-icons/lu';
import { errorMessage } from '../../lib/errors';
import type { Assignable } from '../../lib/issuePeople';
import { TEMPLATE_GROUPS } from '../../lib/issueTemplates';
import type { EstimateOptions } from '../../lib/validation';
import type {
  CycleRead,
  EstimateScale,
  IssuePriority,
  LabelRead,
  ProjectRead,
  StatusRead,
  TemplateCreate,
  TemplateRead,
  TemplateUpdate,
} from '../../types/Api';
import {
  AssigneePicker,
  CyclePicker,
  EstimatePicker,
  LabelsPicker,
  PriorityPicker,
  ProjectPicker,
  StatusPicker,
} from '../issues/PropertyPickers';
import { ErrorAlert } from '../ui/alert';
import { Badge } from '../ui/badge';
import Button, { IconButton } from '../ui/button';
import { Input, Textarea } from '../ui/input';
import Label from '../ui/label';

/** The lists the form's pickers choose from. Planning lists are team only. */
export interface TemplateEditorOptions {
  statuses: StatusRead[];
  labels: LabelRead[];
  people?: Assignable[];
  projects?: ProjectRead[];
  cycles?: CycleRead[];
  estimateScale?: EstimateScale;
  estimateOptions?: EstimateOptions;
}

/** The writes the editor calls, each rejecting as its route does. */
export interface TemplateEditorActions {
  create: (body: TemplateCreate) => Promise<unknown>;
  update: (template: TemplateRead, body: TemplateUpdate) => Promise<unknown>;
  remove: (template: TemplateRead) => Promise<unknown>;
}

/** Props for TemplateEditor. */
export interface TemplateEditorProps {
  templates: TemplateRead[];
  /** Whose templates these are: a team's own, or the workspace's. */
  scope: 'team' | 'workspace';
  canEdit: boolean;
  options: TemplateEditorOptions;
  actions: TemplateEditorActions;
  /** The template the team's create dialog opens with, marked in the list. */
  defaultTemplateId?: string | null;
}

/** The form's working copy of one template. */
interface FormState {
  name: string;
  title: string;
  body: string;
  statusId: string | null;
  priority: IssuePriority;
  assigneeId: string | null;
  labelIds: string[];
  estimate: string | null;
  projectId: string | null;
  cycleId: string | null;
}

const EMPTY_FORM: FormState = {
  name: '',
  title: '',
  body: '',
  statusId: null,
  priority: 'none',
  assigneeId: null,
  labelIds: [],
  estimate: null,
  projectId: null,
  cycleId: null,
};

/** The form a saved template opens into. */
const formOf = (template: TemplateRead): FormState => ({
  name: template.name,
  title: template.title ?? '',
  body: template.body ?? '',
  statusId: template.status_id,
  priority: template.priority ?? 'none',
  assigneeId: template.assignee_id,
  labelIds: template.label_ids,
  estimate: template.estimate,
  projectId: template.project_id,
  cycleId: template.cycle_id,
});

/** Every field of the form as a write sends it, blanks as null. */
const fieldsOf = (form: FormState) => ({
  title: form.title.trim() === '' ? null : form.title,
  body: form.body.trim() === '' ? null : form.body,
  status_id: form.statusId,
  priority: form.priority === 'none' ? null : form.priority,
  assignee_id: form.assigneeId,
  label_ids: form.labelIds,
  estimate: form.estimate,
  project_id: form.projectId,
  cycle_id: form.cycleId,
});

/** The create body, leaving out every field still empty. */
const createBodyOf = (form: FormState): TemplateCreate => {
  const body: TemplateCreate = { name: form.name.trim() };
  for (const [name, value] of Object.entries(fieldsOf(form))) {
    if (value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    Object.assign(body, { [name]: value });
  }
  return body;
};

/**
 * The patch body: every field, so a cleared one is cleared, and the
 * milestone dropped when the project changed under it.
 */
const updateBodyOf = (
  template: TemplateRead,
  form: FormState
): TemplateUpdate => ({
  name: form.name.trim(),
  ...fieldsOf(form),
  ...(form.projectId === template.project_id
    ? {}
    : { project_milestone_id: null }),
});

/** Props for TemplateForm. */
interface TemplateFormProps {
  initial: FormState;
  scope: 'team' | 'workspace';
  options: TemplateEditorOptions;
  submitLabel: string;
  onSubmit: (form: FormState) => Promise<unknown>;
  onCancel: () => void;
}

/** The name, default text and default properties of one template. */
const TemplateForm: React.FC<TemplateFormProps> = ({
  initial,
  scope,
  options,
  submitLabel,
  onSubmit,
  onCancel,
}) => {
  const [form, setForm] = useState<FormState>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (change: Partial<FormState>): void => {
    setForm((held) => ({ ...held, ...change }));
  };
  const team = scope === 'team';

  return (
    <form
      aria-label={submitLabel}
      className="space-y-3 rounded-md border border-line p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (form.name.trim() === '' || saving) return;
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
        <Label htmlFor="template-name">Template name</Label>
        <Input
          id="template-name"
          value={form.name}
          maxLength={80}
          placeholder="Bug report"
          onChange={(event) => {
            set({ name: event.target.value });
          }}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="template-title">Issue title</Label>
        <Input
          id="template-title"
          value={form.title}
          placeholder="Left empty, the title is typed each time"
          onChange={(event) => {
            set({ title: event.target.value });
          }}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="template-body">Description</Label>
        <Textarea
          id="template-body"
          rows={5}
          value={form.body}
          placeholder="Steps to reproduce, expected and actual results"
          onChange={(event) => {
            set({ body: event.target.value });
          }}
        />
      </div>
      <div
        role="group"
        aria-label="Template properties"
        className="flex flex-wrap items-center gap-1.5"
      >
        <StatusPicker
          variant="chip"
          statuses={options.statuses}
          value={form.statusId}
          onChange={(statusId) => {
            set({ statusId });
          }}
        />
        {form.statusId !== null && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              set({ statusId: null });
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
          <AssigneePicker
            variant="chip"
            people={options.people ?? []}
            value={form.assigneeId}
            onChange={(assigneeId) => {
              set({ assigneeId });
            }}
          />
        )}
        <LabelsPicker
          variant="chip"
          labels={options.labels}
          value={form.labelIds}
          onChange={(labelIds) => {
            set({ labelIds });
          }}
        />
        {team && (options.estimateScale ?? 'off') !== 'off' && (
          <EstimatePicker
            variant="chip"
            scale={options.estimateScale ?? 'off'}
            extended={options.estimateOptions?.extended ?? false}
            allowZero={options.estimateOptions?.allowZero ?? false}
            value={form.estimate}
            onChange={(estimate) => {
              set({ estimate });
            }}
          />
        )}
        {team && (
          <ProjectPicker
            variant="chip"
            projects={options.projects ?? []}
            value={form.projectId}
            onChange={(projectId) => {
              set({ projectId });
            }}
          />
        )}
        {team && (
          <CyclePicker
            variant="chip"
            cycles={options.cycles ?? []}
            value={form.cycleId}
            onChange={(cycleId) => {
              set({ cycleId });
            }}
          />
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={form.name.trim() === '' || saving}
        >
          {saving ? 'Saving' : submitLabel}
        </Button>
      </div>
    </form>
  );
};

/** Lists and edits a set of issue templates. */
export const TemplateEditor: React.FC<TemplateEditorProps> = ({
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
          No templates yet.
          {canEdit ? ' Add one to prefill new issues.' : ''}
        </p>
      )}

      {own.length > 0 && (
        <ul aria-label="Templates" className="divide-y divide-line">
          {own.map((template, index) =>
            editing === template.id ? (
              <li key={template.id} className="py-2">
                <TemplateForm
                  initial={formOf(template)}
                  scope={scope}
                  options={options}
                  submitLabel="Save template"
                  onCancel={() => {
                    setEditing(null);
                  }}
                  onSubmit={(form) =>
                    actions
                      .update(template, updateBodyOf(template, form))
                      .then(() => {
                        setEditing(null);
                      })
                  }
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
                  {template.title !== null && (
                    <p className="truncate text-xs text-text-muted">
                      {template.title}
                    </p>
                  )}
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
          <TemplateForm
            initial={EMPTY_FORM}
            scope={scope}
            options={options}
            submitLabel="Create template"
            onCancel={() => {
              setEditing(null);
            }}
            onSubmit={(form) =>
              actions.create(createBodyOf(form)).then(() => {
                setEditing(null);
              })
            }
          />
        ) : (
          <Button
            size="sm"
            onClick={() => {
              setEditing('new');
            }}
          >
            New template
          </Button>
        ))}

      {inherited.length > 0 && (
        <div className="space-y-1 pt-2">
          <p className="text-xs font-medium text-text-faint">Inherited</p>
          <ul aria-label="Inherited templates" className="divide-y divide-line">
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

export default TemplateEditor;
