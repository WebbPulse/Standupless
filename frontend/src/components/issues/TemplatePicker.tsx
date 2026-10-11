/**
 * The template chip in the new issue dialog's header. It names the template
 * the draft started from and opens a filterable list of the templates the
 * team offers, grouped by where each is kept, with "No template" first to go
 * back to a blank draft.
 */

import React from 'react';
import { LuFileText } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { TEMPLATE_GROUPS } from '../../lib/issueTemplates';
import type { TemplateRead } from '../../types/Api';
import { Combobox, type ComboboxOption } from '../ui/combobox';
import { Popover } from '../ui/popover';

/** The value the "No template" row carries. */
const NONE = '';

/** Props for TemplatePicker: the templates offered and the one in use. */
export interface TemplatePickerProps {
  templates: readonly TemplateRead[];
  value: string | null;
  onChange: (template: TemplateRead | null) => void;
}

/** A header chip choosing the template a new issue starts from. */
export const TemplatePicker: React.FC<TemplatePickerProps> = ({
  templates,
  value,
  onChange,
}) => {
  const current = templates.find((template) => template.id === value);
  const options: ComboboxOption[] = [
    { value: NONE, label: 'No template' },
    ...templates.map((template) => ({
      value: template.id,
      label: template.name,
      group: TEMPLATE_GROUPS[template.scope],
      icon: <LuFileText className="h-3.5 w-3.5" />,
    })),
  ];
  const name = current?.name ?? 'Template';

  return (
    <Popover
      label="Template"
      contentClassName="w-64"
      trigger={(trigger) => (
        <button
          type="button"
          aria-label={
            current === undefined ? 'Template: none' : `Template: ${name}`
          }
          {...trigger}
          className={cn(
            'inline-flex h-6 max-w-48 items-center gap-1.5 truncate rounded-sm border border-line px-2 text-xs hover:border-line-strong hover:bg-raised',
            current === undefined ? 'text-text-faint' : 'text-text-muted'
          )}
        >
          <LuFileText aria-hidden="true" className="h-3 w-3 shrink-0" />
          <span className="truncate">{name}</span>
        </button>
      )}
    >
      {(close) => (
        <Combobox
          label="Template"
          placeholder="Use a template"
          options={options}
          selected={[value ?? NONE]}
          onSelect={(picked) => {
            close();
            if (picked === (value ?? NONE)) return;
            onChange(
              templates.find((template) => template.id === picked) ?? null
            );
          }}
        />
      )}
    </Popover>
  );
};

export default TemplatePicker;
