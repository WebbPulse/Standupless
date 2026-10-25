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
 *
 * The same editor keeps document templates, which are a name, a title and a
 * Markdown body with none of the issue properties, so the new document flow
 * and the update composer start from text a team agreed on.
 *
 * An issue template can also be a form: a list of questions the create dialog
 * asks in place of a free description, whose answers land in the body and
 * whose issues go to the team's triage. It can also carry sub-issues, created
 * under every issue made from it.
 */

import React, { useState } from 'react';
import {
  LuArrowDown,
  LuArrowUp,
  LuPencil,
  LuRepeat,
  LuTrash2,
} from 'react-icons/lu';
import { errorMessage } from '../../lib/errors';
import type { Assignable } from '../../lib/issuePeople';
import {
  isFormTemplate,
  needsAnswers,
  TEMPLATE_GROUPS,
} from '../../lib/issueTemplates';
import type { EstimateOptions } from '../../lib/validation';
import type {
  CycleRead,
  EstimateScale,
  FormField,
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
import { Checkbox } from '../ui/checkbox';
import { Input, Textarea } from '../ui/input';
import Label from '../ui/label';
import { FormFieldsEditor, formFieldsComplete } from './FormFieldsEditor';
import {
  type SubIssueDraft,
  SubIssuesEditor,
  subIssueDrafts,
  subIssuesOf,
} from './SubIssuesEditor';

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
  /** Opens a recurring schedule for a template; the button shows when set. */
  onMakeRecurring?: (template: TemplateRead) => void;
  /** What the templates fill: a new issue, or a new document or update. */
  kind?: EditorKind;
}

/** The template kinds this editor keeps; project templates have their own. */
export type EditorKind = 'issue' | 'document';

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
  isForm: boolean;
  formFields: FormField[];
  subIssues: SubIssueDraft[];
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
  isForm: false,
  formFields: [],
  subIssues: [],
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
  isForm: (template.form_fields ?? []).length > 0,
  formFields: template.form_fields ?? [],
  subIssues: subIssueDrafts(template.sub_issues),
});

/** The questions a write sends: none unless the template is a form. */
const formFieldsOf = (form: FormState): FormField[] =>
  form.isForm
    ? form.formFields.map((field) => ({
        ...field,
        description: field.description?.trim() ? field.description : null,
      }))
    : [];

/** Whether the form can be saved: a name, titled sub-issues, and a complete set of questions when it is a form. */
const savable = (form: FormState): boolean =>
  form.name.trim() !== '' &&
  form.subIssues.every((row) => row.title.trim() !== '') &&
  (!form.isForm ||
    (form.formFields.length > 0 && formFieldsComplete(form.formFields)));

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
  form_fields: formFieldsOf(form),
  sub_issues: subIssuesOf(form.subIssues),
});

/** The fields a document template carries, blanks as null. */
const documentFieldsOf = (form: FormState) => ({
  title: form.title.trim() === '' ? null : form.title,
  body: form.body.trim() === '' ? null : form.body,
});

/** The create body, leaving out every field still empty. */
const createBodyOf = (form: FormState, kind: EditorKind): TemplateCreate => {
  const body: TemplateCreate =
    kind === 'document'
      ? { name: form.name.trim(), kind: 'document' }
      : { name: form.name.trim() };
  const fields = kind === 'document' ? documentFieldsOf(form) : fieldsOf(form);
  for (const [name, value] of Object.entries(fields)) {
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
  form: FormState,
  kind: EditorKind
): TemplateUpdate =>
  kind === 'document'
    ? { name: form.name.trim(), ...documentFieldsOf(form) }
    : issueUpdateBodyOf(template, form);

/** The patch body of an issue template. */
const issueUpdateBodyOf = (
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
  kind: EditorKind;
}

/** The copy the form shows for each kind it keeps. */
const FORM_COPY: Record<
  EditorKind,
  {
    namePlaceholder: string;
    titleLabel: string;
    titlePlaceholder: string;
    bodyLabel: string;
    bodyPlaceholder: string;
  }
> = {
  issue: {
    namePlaceholder: 'Bug report',
    titleLabel: 'Issue title',
    titlePlaceholder: 'Left empty, the title is typed each time',
    bodyLabel: 'Description',
    bodyPlaceholder: 'Steps to reproduce, expected and actual results',
  },
  document: {
    namePlaceholder: 'Spec',
    titleLabel: 'Document title',
    titlePlaceholder: 'Left empty, a new document starts Untitled',
    bodyLabel: 'Body',
    bodyPlaceholder: '## Goal\n\n## Plan\n\n## Open questions',
  },
};

/** The name, default text and default properties of one template. */
const TemplateForm: React.FC<TemplateFormProps> = ({
  initial,
  scope,
  options,
  submitLabel,
  onSubmit,
  onCancel,
  kind,
}) => {
  const [form, setForm] = useState<FormState>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (change: Partial<FormState>): void => {
    setForm((held) => ({ ...held, ...change }));
  };
  const team = scope === 'team';
  const copy = FORM_COPY[kind];

  return (
    <form
      aria-label={submitLabel}
      className="space-y-3 rounded-md border border-line p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!savable(form) || saving) return;
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
          placeholder={copy.namePlaceholder}
          onChange={(event) => {
            set({ name: event.target.value });
          }}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="template-title">{copy.titleLabel}</Label>
        <Input
          id="template-title"
          value={form.title}
          placeholder={copy.titlePlaceholder}
          onChange={(event) => {
            set({ title: event.target.value });
          }}
        />
      </div>
      {kind === 'issue' && (
        <div className="space-y-2">
          <Checkbox
            label="Ask questions with a form"
            checked={form.isForm}
            onChange={(event) => {
              set({ isForm: event.target.checked });
            }}
          />
          {form.isForm && (
            <>
              <p className="text-xs text-text-muted">
                The create dialog asks these questions, the answers land in the
                description, and the issue goes to the team&apos;s triage.
              </p>
              <FormFieldsEditor
                fields={form.formFields}
                labels={options.labels}
                onChange={(formFields) => {
                  set({ formFields });
                }}
              />
            </>
          )}
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor="template-body">{copy.bodyLabel}</Label>
        <Textarea
          id="template-body"
          rows={kind === 'document' ? 8 : 5}
          value={form.body}
          placeholder={copy.bodyPlaceholder}
          onChange={(event) => {
            set({ body: event.target.value });
          }}
        />
      </div>
      {kind === 'issue' && (
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
      )}
      {kind === 'issue' && (
        <div className="border-t border-line pt-3">
          <SubIssuesEditor
            rows={form.subIssues}
            statuses={options.statuses}
            labels={options.labels}
            team={team}
            people={options.people ?? []}
            estimateScale={options.estimateScale ?? 'off'}
            {...(options.estimateOptions
              ? { estimateOptions: options.estimateOptions }
              : {})}
            onChange={(subIssues) => {
              set({ subIssues });
            }}
          />
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!savable(form) || saving}
        >
          {saving ? 'Saving' : submitLabel}
        </Button>
      </div>
    </form>
  );
};

/** Lists and edits a set of issue or document templates. */
export const TemplateEditor: React.FC<TemplateEditorProps> = ({
  templates,
  scope,
  canEdit,
  options,
  actions,
  defaultTemplateId = null,
  onMakeRecurring,
  kind = 'issue',
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
  const recurrable = (template: TemplateRead): boolean =>
    onMakeRecurring !== undefined && !needsAnswers(template);

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
          {canEdit
            ? kind === 'document'
              ? ' Add one to start new documents and updates.'
              : ' Add one to prefill new issues.'
            : ''}
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
                  kind={kind}
                  onCancel={() => {
                    setEditing(null);
                  }}
                  onSubmit={(form) =>
                    actions
                      .update(template, updateBodyOf(template, form, kind))
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
                    {(template.form_fields ?? []).length > 0 && (
                      <Badge>Form</Badge>
                    )}
                    {(template.sub_issues ?? []).length > 0 && (
                      <Badge>
                        {(template.sub_issues ?? []).length === 1
                          ? '1 sub-issue'
                          : `${String((template.sub_issues ?? []).length)} sub-issues`}
                      </Badge>
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
                      {recurrable(template) && (
                        <IconButton
                          size="sm"
                          label={`Make ${template.name} recurring`}
                          onClick={() => {
                            onMakeRecurring?.(template);
                          }}
                        >
                          <LuRepeat className="h-3.5 w-3.5" />
                        </IconButton>
                      )}
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
            kind={kind}
            onCancel={() => {
              setEditing(null);
            }}
            onSubmit={(form) =>
              actions.create(createBodyOf(form, kind)).then(() => {
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
                {isFormTemplate(template) && <Badge>Form</Badge>}
                <Badge>{TEMPLATE_GROUPS[template.scope]}</Badge>
                {canEdit && recurrable(template) && (
                  <IconButton
                    size="sm"
                    label={`Make ${template.name} recurring`}
                    onClick={() => {
                      onMakeRecurring?.(template);
                    }}
                  >
                    <LuRepeat className="h-3.5 w-3.5" />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default TemplateEditor;
