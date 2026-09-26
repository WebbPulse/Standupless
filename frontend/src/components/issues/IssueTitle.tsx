/**
 * An issue's title, edited as the heading itself. Someone who may edit sees a
 * borderless field set in the heading's own type, so clicking the title puts
 * a caret in it and nothing moves; a reader sees the plain heading. Enter or
 * leaving the field saves, and Escape puts the saved title back.
 */

import React, { useRef, useState } from 'react';
import { useAutoGrow } from '../../hooks/useAutoGrow';
import { useKeyboardFocus } from '../../hooks/useKeyboardFocus';
import { cn } from '../../lib/cn';
import { validateTitle } from '../../lib/validation';
import { ErrorAlert } from '../ui/alert';

/** Props for IssueTitle: the saved title, whether it may change, and the save. */
export interface IssueTitleProps {
  title: string;
  canEdit: boolean;
  /** Persists a changed title. Resolves true once it lands. */
  onSave: (title: string) => Promise<boolean>;
}

/** The heading's type, shared by the field so editing looks like reading. */
const TITLE_CLASS = 'text-xl leading-7 font-semibold text-text';

/** The issue title, editable in place. */
export const IssueTitle: React.FC<IssueTitleProps> = ({
  title,
  canEdit,
  onSave,
}) => {
  const [draft, setDraft] = useState(title);
  const [focused, setFocused] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const reverting = useRef(false);
  const { keyboardFocused, focusProps } = useKeyboardFocus();
  useAutoGrow(field);

  const [seen, setSeen] = useState(title);
  if (title !== seen) {
    setSeen(title);
    if (!focused) setDraft(title);
  }

  if (!canEdit) {
    return <h2 className={cn('min-w-0', TITLE_CLASS)}>{title}</h2>;
  }

  const commit = (): void => {
    const next = draft.trim();
    if (next === '' || next === title) {
      setDraft(title);
      setProblem(null);
      return;
    }
    const invalid = validateTitle(next);
    if (invalid !== null) {
      setProblem(invalid);
      return;
    }
    setProblem(null);
    void onSave(next).then((saved) => {
      if (!saved) setDraft(title);
    });
  };

  return (
    <div className="space-y-2">
      <h2 className={cn('min-w-0', TITLE_CLASS)}>
        <textarea
          ref={field}
          rows={1}
          value={draft}
          aria-label="Issue title"
          spellCheck
          className={cn(
            TITLE_CLASS,
            'block w-full resize-none overflow-hidden rounded-xs border-0 bg-transparent p-0 font-sans outline-none focus-visible:outline-none',
            keyboardFocused && 'outline-2 outline-offset-4 outline-focus'
          )}
          {...focusProps}
          onFocus={() => {
            focusProps.onFocus();
            setFocused(true);
          }}
          onBlur={(event) => {
            focusProps.onBlur(event);
            setFocused(false);
            if (reverting.current) {
              reverting.current = false;
              return;
            }
            commit();
          }}
          onChange={(event) => {
            setDraft(event.target.value.replace(/\s*\n\s*/g, ' '));
            setProblem(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.blur();
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              reverting.current = true;
              setDraft(title);
              setProblem(null);
              event.currentTarget.blur();
            }
          }}
        />
      </h2>
      <ErrorAlert message={problem} />
    </div>
  );
};

export default IssueTitle;
