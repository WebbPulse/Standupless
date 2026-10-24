/**
 * The questions a form template asks in the new issue dialog. Each answer
 * is held by its field key, and the dialog sends them as `form_answers`; the
 * server renders them into the description and files the issue to triage.
 */

import React from 'react';
import type { FormFieldRead } from '../../types/Api';
import { Checkbox } from '../ui/checkbox';
import { Input, Textarea } from '../ui/input';
import Label from '../ui/label';
import { Select } from '../ui/select';

/** A form's answers by field key. */
export type FormAnswers = Record<string, string | boolean>;

/** Props for FormQuestions. */
export interface FormQuestionsProps {
  fields: FormFieldRead[];
  answers: FormAnswers;
  onChange: (answers: FormAnswers) => void;
}

/** Whether a field still needs an answer before the issue can be filed. */
const unanswered = (field: FormFieldRead, answer: unknown): boolean => {
  if (!field.required) return false;
  if (field.type === 'checkbox') return answer !== true;
  return typeof answer !== 'string' || answer.trim() === '';
};

/** The required questions not yet answered, in form order. */
export const missingAnswers = (
  fields: FormFieldRead[],
  answers: FormAnswers
): FormFieldRead[] =>
  fields.filter((field) => unanswered(field, answers[field.key]));

/** The answers as the create sends them: blank text left out, checkboxes as true or false. */
export const sentAnswers = (
  fields: FormFieldRead[],
  answers: FormAnswers
): FormAnswers => {
  const sent: FormAnswers = {};
  for (const field of fields) {
    const answer = answers[field.key];
    if (field.type === 'checkbox') {
      sent[field.key] = answer === true;
    } else if (typeof answer === 'string' && answer.trim() !== '') {
      sent[field.key] = answer;
    }
  }
  return sent;
};

/** Renders each question of a form with the control its type takes. */
export const FormQuestions: React.FC<FormQuestionsProps> = ({
  fields,
  answers,
  onChange,
}) => {
  const set = (key: string, value: string | boolean): void => {
    onChange({ ...answers, [key]: value });
  };

  return (
    <div
      role="group"
      aria-label="Form"
      className="space-y-3 rounded-md border border-line p-3"
    >
      {fields.map((field) => {
        const id = `form-question-${field.key}`;
        const answer = answers[field.key];
        const text = typeof answer === 'string' ? answer : '';
        const help =
          field.description === null || field.description === undefined
            ? null
            : field.description;
        return (
          <div key={field.key} className="space-y-1">
            {field.type === 'checkbox' ? (
              <Checkbox
                label={
                  <span>
                    {field.label}
                    {field.required && (
                      <span className="text-text-faint"> (required)</span>
                    )}
                  </span>
                }
                checked={answer === true}
                onChange={(event) => {
                  set(field.key, event.target.checked);
                }}
              />
            ) : (
              <Label htmlFor={id}>
                {field.label}
                {field.required && (
                  <span className="text-text-faint"> (required)</span>
                )}
              </Label>
            )}
            {help !== null && <p className="text-xs text-text-muted">{help}</p>}
            {field.type === 'short_text' && (
              <Input
                id={id}
                value={text}
                maxLength={500}
                required={field.required}
                onChange={(event) => {
                  set(field.key, event.target.value);
                }}
              />
            )}
            {field.type === 'long_text' && (
              <Textarea
                id={id}
                rows={3}
                value={text}
                required={field.required}
                onChange={(event) => {
                  set(field.key, event.target.value);
                }}
              />
            )}
            {field.type === 'select' && (
              <Select
                id={id}
                value={text}
                required={field.required}
                onChange={(event) => {
                  set(field.key, event.target.value);
                }}
              >
                <option value="">Choose one</option>
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.value}
                  </option>
                ))}
              </Select>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default FormQuestions;
