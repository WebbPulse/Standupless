/**
 * An issue's title, edited as the heading itself. Someone who may edit sees a
 * borderless field set in the heading's own type, so clicking the title puts
 * a caret in it and nothing moves; a reader sees the plain heading. Enter or
 * leaving the field saves, and Escape puts the saved title back. When the
 * description below may be edited, Enter, or ArrowDown at the end of the
 * title, saves and moves the caret to the start of the description. R, or the
 * palette's Rename issue, puts the caret in the field with the title selected.
 */

import React, { useImperativeHandle, useRef, useState } from 'react';
import { useAutoGrow } from '../../hooks/useAutoGrow';
import { useKeyboardFocus } from '../../hooks/useKeyboardFocus';
import { useShortcut } from '../../hooks/useShortcuts';
import { cn } from '../../lib/cn';
import { validateTitle } from '../../lib/validation';
import { ErrorAlert } from '../ui/alert';
import { RENAME_ISSUE_KEYS } from './view/propertyKeys';

/** What a parent can do to the title from outside. */
export interface IssueTitleHandle {
  /** Puts the caret at the end of the title. */
  focusEnd: () => void;
}

/** Props for IssueTitle: the saved title, whether it may change, and the save. */
export interface IssueTitleProps {
  title: string;
  canEdit: boolean;
  /** Persists a changed title. Resolves true once it lands. */
  onSave: (title: string) => Promise<boolean>;
  /**
   * Moves the caret into the description, at its start. Unset, as for a read
   * only description, Enter saves and leaves the field instead.
   */
  onExitDown?: () => void;
  /** Receives the imperative handle. */
  ref?: React.Ref<IssueTitleHandle>;
}

/** The heading's type, shared by the field so editing looks like reading. */
const TITLE_CLASS =
  'text-[24px] leading-8 font-semibold tracking-[-0.01em] text-text';

/** The issue title, editable in place. */
export const IssueTitle: React.FC<IssueTitleProps> = ({
  title,
  canEdit,
  onSave,
  onExitDown,
  ref,
}) => {
  const [draft, setDraft] = useState(title);
  const [focused, setFocused] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const reverting = useRef(false);
  const { keyboardFocused, focusProps } = useKeyboardFocus();
  useAutoGrow(field);

  useImperativeHandle(
    ref,
    () => ({
      focusEnd: () => {
        const input = field.current;
        if (input === null) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      },
    }),
    []
  );

  useShortcut({
    keys: RENAME_ISSUE_KEYS,
    label: 'Rename issue',
    scope: 'issue',
    group: 'Issue',
    enabled: canEdit,
    handler: (event) => {
      event?.preventDefault();
      field.current?.focus();
      field.current?.select();
    },
  });

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

  const exitDown = (input: HTMLTextAreaElement): void => {
    onExitDown?.();
    if (document.activeElement === input) input.blur();
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
            const input = event.currentTarget;
            const composing = event.nativeEvent.isComposing;
            if (event.key === 'Enter' && !composing) {
              event.preventDefault();
              if (event.shiftKey) return;
              exitDown(input);
              return;
            }
            if (
              event.key === 'ArrowDown' &&
              !composing &&
              onExitDown !== undefined &&
              !event.shiftKey &&
              !event.altKey &&
              !event.metaKey &&
              !event.ctrlKey &&
              input.selectionStart === input.value.length &&
              input.selectionEnd === input.value.length
            ) {
              event.preventDefault();
              exitDown(input);
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
