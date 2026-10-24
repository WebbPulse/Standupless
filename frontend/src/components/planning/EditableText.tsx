/**
 * Text that reads as plain content and edits in place, the way a project's
 * name, its description and its milestones are edited on the project page.
 */

import React, { useRef, useState } from 'react';
import { useAutoGrow } from '../../hooks/useAutoGrow';
import { cn } from '../../lib/cn';

/** Props for EditableText: the saved text and how to save a change. */
export interface EditableTextProps {
  value: string;
  label: string;
  placeholder: string;
  disabled: boolean;
  multiline?: boolean;
  className?: string;
  onSave: (value: string) => void;
}

/**
 * Text that reads as plain content and edits in place. The draft lives only
 * while the field has focus, so a poll that lands mid-edit does not overwrite
 * what is being typed, blur or Cmd+Enter saves it, and Escape drops it. A
 * multiline field grows with its content, reading or editing, so it never
 * scrolls inside itself.
 */
export const EditableText: React.FC<EditableTextProps> = ({
  value,
  label,
  placeholder,
  disabled,
  multiline = false,
  className = '',
  onSave,
}) => {
  const [draft, setDraft] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const discarding = useRef(false);
  useAutoGrow(area);
  const commit = (text: string): void => {
    setDraft(null);
    if (text.trim() !== value.trim()) onSave(text.trim());
  };
  const shared = {
    'aria-label': label,
    placeholder,
    readOnly: disabled,
    value: draft ?? value,
    onFocus: () => {
      if (!disabled) setDraft(value);
    },
    onBlur: () => {
      if (discarding.current) {
        discarding.current = false;
        setDraft(null);
        return;
      }
      if (draft !== null) commit(draft);
    },
    className: cn(
      'w-full resize-none rounded-sm bg-transparent text-text placeholder:text-text-faint focus:outline-none',
      className
    ),
  };
  if (multiline) {
    return (
      <textarea
        {...shared}
        ref={area}
        rows={Math.max(3, (draft ?? value).split('\n').length + 1)}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            discarding.current = true;
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
      />
    );
  }
  return (
    <input
      {...shared}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === 'Escape') {
          discarding.current = true;
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
    />
  );
};

export default EditableText;
