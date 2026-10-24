/**
 * The questions of a form template, edited in place inside the template
 * form. Each question has a label, an answer type, optional help text and a
 * required switch, and a select question lists its choices, each of which can
 * put a label and a priority on the issue filed from the form.
 */

import React from 'react';
import { LuArrowDown, LuArrowUp, LuPlus, LuTrash2, LuX } from 'react-icons/lu';
import { PRIORITIES, PRIORITY_LABELS } from '../../lib/issueDisplay';
import type {
  FormField,
  FormFieldType,
  FormOption,
  IssuePriority,
  LabelRead,
} from '../../types/Api';
import Button, { IconButton } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Select } from '../ui/select';

/** The most questions a form takes, as the server holds it. */
export const FORM_FIELDS_MAX = 20;

/** The most choices a select question takes. */
export const FORM_OPTIONS_MAX = 25;

/** How each answer type reads in the type picker. */
export const FORM_FIELD_TYPES: Record<FormFieldType, string> = {
  short_text: 'Short text',
  long_text: 'Long text',
  select: 'Select',
  checkbox: 'Checkbox',
};

/** Props for FormFieldsEditor. */
export interface FormFieldsEditorProps {
  fields: FormField[];
  labels: LabelRead[];
  onChange: (fields: FormField[]) => void;
}

/** A question as it is first added: a short text answer, not required. */
const NEW_FIELD: FormField = {
  label: '',
  type: 'short_text',
  required: false,
  description: null,
  options: [],
};

/** The next free `f` key, so a question keeps its key, and its answers, as it moves. */
const nextKey = (fields: FormField[]): string => {
  const taken = new Set(fields.map((field) => field.key));
  let number = 1;
  while (taken.has(`f${String(number)}`)) number += 1;
  return `f${String(number)}`;
};

/** The question with one change applied, its choices dropped when it stops being a select. */
const changed = (field: FormField, change: Partial<FormField>): FormField => {
  const next = { ...field, ...change };
  if (next.type !== 'select') return { ...next, options: [] };
  if ((next.options ?? []).length === 0) {
    return { ...next, options: [{ value: '' }] };
  }
  return next;
};

/** Props for OptionRow. */
interface OptionRowProps {
  option: FormOption;
  position: number;
  questionLabel: string;
  labels: LabelRead[];
  onChange: (option: FormOption) => void;
  onRemove: (() => void) | null;
}

/** One choice of a select question, with the label and priority it maps to. */
const OptionRow: React.FC<OptionRowProps> = ({
  option,
  position,
  questionLabel,
  labels,
  onChange,
  onRemove,
}) => {
  const name = `${questionLabel || 'Question'} choice ${String(position + 1)}`;
  return (
    <li className="flex flex-wrap items-center gap-1.5">
      <Input
        aria-label={name}
        className="min-w-0 flex-1"
        value={option.value}
        maxLength={80}
        placeholder="Choice"
        onChange={(event) => {
          onChange({ ...option, value: event.target.value });
        }}
      />
      <Select
        aria-label={`${name} label`}
        className="w-36"
        value={option.label_id ?? ''}
        onChange={(event) => {
          onChange({ ...option, label_id: event.target.value || null });
        }}
      >
        <option value="">No label</option>
        {labels.map((label) => (
          <option key={label.id} value={label.id}>
            {label.name}
          </option>
        ))}
      </Select>
      <Select
        aria-label={`${name} priority`}
        className="w-32"
        value={option.priority ?? 'none'}
        onChange={(event) => {
          const priority = event.target.value as IssuePriority;
          onChange({
            ...option,
            priority: priority === 'none' ? null : priority,
          });
        }}
      >
        {PRIORITIES.map((priority) => (
          <option key={priority} value={priority}>
            {priority === 'none' ? 'Keep priority' : PRIORITY_LABELS[priority]}
          </option>
        ))}
      </Select>
      {onRemove !== null && (
        <IconButton size="sm" label={`Remove ${name}`} onClick={onRemove}>
          <LuX className="h-3.5 w-3.5" />
        </IconButton>
      )}
    </li>
  );
};

/** Edits the questions of a form template, in order. */
export const FormFieldsEditor: React.FC<FormFieldsEditorProps> = ({
  fields,
  labels,
  onChange,
}) => {
  const update = (index: number, change: Partial<FormField>): void => {
    onChange(
      fields.map((field, at) => (at === index ? changed(field, change) : field))
    );
  };
  const move = (index: number, by: number): void => {
    const target = index + by;
    if (target < 0 || target >= fields.length) return;
    const order = [...fields];
    const [moved] = order.splice(index, 1);
    if (moved === undefined) return;
    order.splice(target, 0, moved);
    onChange(order);
  };

  return (
    <div role="group" aria-label="Form questions" className="space-y-2">
      {fields.length === 0 && (
        <p className="text-xs text-text-muted">
          Add the questions people answer when they file from this form.
        </p>
      )}
      <ol className="space-y-2">
        {fields.map((field, index) => {
          const number = String(index + 1);
          const options = field.options ?? [];
          return (
            <li
              key={field.key ?? `question-${number}`}
              className="space-y-2 rounded-md border border-line p-2"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <Input
                  aria-label={`Question ${number}`}
                  className="min-w-0 flex-1"
                  value={field.label}
                  maxLength={120}
                  placeholder="What happened?"
                  onChange={(event) => {
                    update(index, { label: event.target.value });
                  }}
                />
                <Select
                  aria-label={`Question ${number} type`}
                  className="w-32"
                  value={field.type ?? 'short_text'}
                  onChange={(event) => {
                    update(index, {
                      type: event.target.value as FormFieldType,
                    });
                  }}
                >
                  {Object.entries(FORM_FIELD_TYPES).map(([value, name]) => (
                    <option key={value} value={value}>
                      {name}
                    </option>
                  ))}
                </Select>
                <IconButton
                  size="sm"
                  label={`Move question ${number} up`}
                  disabled={index === 0}
                  onClick={() => {
                    move(index, -1);
                  }}
                >
                  <LuArrowUp className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton
                  size="sm"
                  label={`Move question ${number} down`}
                  disabled={index === fields.length - 1}
                  onClick={() => {
                    move(index, 1);
                  }}
                >
                  <LuArrowDown className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton
                  size="sm"
                  label={`Remove question ${number}`}
                  onClick={() => {
                    onChange(fields.filter((_, at) => at !== index));
                  }}
                >
                  <LuTrash2 className="h-3.5 w-3.5" />
                </IconButton>
              </div>
              <Input
                aria-label={`Question ${number} help text`}
                value={field.description ?? ''}
                maxLength={500}
                placeholder="Help text, optional"
                onChange={(event) => {
                  update(index, { description: event.target.value || null });
                }}
              />
              <Checkbox
                label={
                  field.type === 'checkbox' ? 'Must be checked' : 'Required'
                }
                checked={field.required ?? false}
                onChange={(event) => {
                  update(index, { required: event.target.checked });
                }}
              />
              {field.type === 'select' && (
                <div className="space-y-1.5">
                  <ul
                    aria-label={`Question ${number} choices`}
                    className="space-y-1.5"
                  >
                    {options.map((option, at) => (
                      <OptionRow
                        key={`${number}-${String(at)}`}
                        option={option}
                        position={at}
                        questionLabel={field.label}
                        labels={labels}
                        onChange={(next) => {
                          update(index, {
                            options: options.map((held, place) =>
                              place === at ? next : held
                            ),
                          });
                        }}
                        onRemove={
                          options.length > 1
                            ? () => {
                                update(index, {
                                  options: options.filter(
                                    (_, place) => place !== at
                                  ),
                                });
                              }
                            : null
                        }
                      />
                    ))}
                  </ul>
                  {options.length < FORM_OPTIONS_MAX && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        update(index, { options: [...options, { value: '' }] });
                      }}
                    >
                      <LuPlus className="h-3.5 w-3.5" />
                      Add choice
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {fields.length < FORM_FIELDS_MAX && (
        <Button
          size="sm"
          onClick={() => {
            onChange([...fields, { ...NEW_FIELD, key: nextKey(fields) }]);
          }}
        >
          <LuPlus className="h-3.5 w-3.5" />
          Add question
        </Button>
      )}
    </div>
  );
};

/** Whether every question has a label and every select choice a value, so the form can be saved. */
export const formFieldsComplete = (fields: FormField[]): boolean =>
  fields.every(
    (field) =>
      field.label.trim() !== '' &&
      (field.type !== 'select' ||
        ((field.options ?? []).length > 0 &&
          (field.options ?? []).every((option) => option.value.trim() !== '')))
  );

export default FormFieldsEditor;
