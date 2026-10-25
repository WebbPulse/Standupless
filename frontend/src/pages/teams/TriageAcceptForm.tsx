/**
 * What the accept popover asks before an issue leaves triage: an optional
 * comment posted as the person accepting, and the status it lands in, which
 * defaults to the team's first unstarted one. Focus starts in the comment and
 * Enter confirms straight away, so the fast path stays one key plus Enter;
 * Shift+Enter breaks a line.
 *
 * A row of priority choices sits under the comment, preselected to the
 * issue's current priority, so it can be set in the same step. Digits pick
 * one in Linear's order (0 none, 1 urgent, 2 high, 3 medium, 4 low) from
 * anywhere in the form while the comment is empty, and with Alt at any time.
 * An issue with no priority gets a short nudge under the row, never a block.
 *
 * When the team requires a priority before an issue leaves triage and the
 * issue has none, No priority is unavailable and the accept waits until one
 * is picked, so the server's refusal is never the first the person hears of it.
 *
 * The choice is one object so later fields, such as an assignee, join it
 * without changing how the page submits it.
 */

import React, { useState } from 'react';
import Button from '../../components/ui/button';
import { Textarea } from '../../components/ui/input';
import Label from '../../components/ui/label';
import { SelectField } from '../../components/ui/select';
import { PriorityGlyph } from '../../components/ui/glyphs';
import { cn } from '../../lib/cn';
import { PRIORITIES, PRIORITY_LABELS } from '../../lib/issueDisplay';
import { defaultAcceptStatus } from '../../lib/triageActions';
import type { IssuePriority, StatusRead } from '../../types/Api';

/** What an accept carries to the server. */
export interface TriageAcceptChoice {
  /** The status to accept into, or null for the server's default. */
  statusId: string | null;
  /** The comment to post, trimmed; empty posts none. */
  comment: string;
  /** The priority to set in the same write, or null to leave it. */
  priority: IssuePriority | null;
}

/** The digit that picks each priority, matching Linear's priority keys. */
export const PRIORITY_DIGITS: Record<IssuePriority, string> = {
  none: '0',
  urgent: '1',
  high: '2',
  medium: '3',
  low: '4',
};

/** The priority a digit key picks, or null when the key picks none. */
export const priorityForDigit = (digit: string): IssuePriority | null =>
  PRIORITIES.find((option) => PRIORITY_DIGITS[option] === digit) ?? null;

/** The digit a key event carries, read from its code so Alt still yields it. */
const eventDigit = (event: React.KeyboardEvent): string | null => {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(event.code);
  if (match !== null) return match[1] ?? null;
  return /^[0-9]$/.test(event.key) ? event.key : null;
};

/** Props for TriageAcceptForm. */
export interface TriageAcceptFormProps {
  /** The issue's key, for the field labels. */
  issueKey: string;
  /** The team's visible statuses, ordered by position. */
  statuses: readonly StatusRead[];
  /** Whether the team requires a priority before an issue leaves triage. */
  requirePriority?: boolean;
  /** The issue's priority as it waits. */
  priority?: IssuePriority;
  saving?: boolean;
  onSubmit: (choice: TriageAcceptChoice) => void;
  onCancel: () => void;
}

/** The accept popover's form. */
export const TriageAcceptForm: React.FC<TriageAcceptFormProps> = ({
  issueKey,
  statuses,
  requirePriority = false,
  priority = 'none',
  saving = false,
  onSubmit,
  onCancel,
}) => {
  const fallback = defaultAcceptStatus(statuses);
  const [comment, setComment] = useState('');
  const [statusId, setStatusId] = useState<string | null>(null);
  const [picked, setPicked] = useState<IssuePriority>(priority);
  const chosen = statusId ?? fallback?.id ?? '';
  const required = requirePriority && priority === 'none';
  const blocked = required && picked === 'none';

  const pick = (next: IssuePriority): void => {
    if (required && next === 'none') return;
    setPicked(next);
  };

  const submit = (): void => {
    if (saving || blocked) return;
    onSubmit({
      statusId: chosen === '' ? null : chosen,
      comment: comment.trim(),
      priority: picked === priority ? null : picked,
    });
  };

  const onFormKeyDown = (event: React.KeyboardEvent<HTMLFormElement>): void => {
    if (event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const digit = eventDigit(event);
    if (digit === null) return;
    const next = priorityForDigit(digit);
    if (next === null) return;
    const target = event.target as HTMLElement;
    const editable =
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLInputElement;
    const typing = editable && target.value !== '';
    if (typing && !event.altKey) return;
    if (target instanceof HTMLSelectElement && !event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    pick(next);
  };

  return (
    <form
      aria-label={`Accept ${issueKey}`}
      className="w-72 max-w-full space-y-3 p-3"
      onKeyDown={onFormKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="triage-accept-comment">Comment (optional)</Label>
        <Textarea
          id="triage-accept-comment"
          autoFocus
          rows={2}
          className="min-h-14"
          placeholder="Add a note for the thread"
          value={comment}
          onChange={(event) => {
            setComment(event.target.value);
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              submit();
            }
          }}
        />
      </div>
      <div className="space-y-1">
        <span
          id="triage-accept-priority-label"
          className="block text-xs font-medium text-text-muted"
        >
          Priority
        </span>
        <div
          role="radiogroup"
          aria-labelledby="triage-accept-priority-label"
          aria-describedby={
            picked === 'none' ? 'triage-accept-priority-hint' : undefined
          }
          className="flex gap-1"
        >
          {PRIORITIES.map((option) => {
            const unavailable = required && option === 'none';
            const checked = picked === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={PRIORITY_LABELS[option]}
                aria-keyshortcuts={PRIORITY_DIGITS[option]}
                title={`${PRIORITY_LABELS[option]} (${PRIORITY_DIGITS[option]})`}
                disabled={unavailable}
                onClick={() => {
                  pick(option);
                }}
                className={cn(
                  'inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-sm border text-xs text-text-muted transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40',
                  checked
                    ? 'border-accent bg-raised text-text'
                    : 'border-line enabled:hover:bg-raised'
                )}
              >
                <PriorityGlyph priority={option} />
                <span className="font-mono text-[10px] opacity-70">
                  {PRIORITY_DIGITS[option]}
                </span>
              </button>
            );
          })}
        </div>
        {picked === 'none' && (
          <p
            id="triage-accept-priority-hint"
            className="text-xs text-text-muted"
          >
            {required
              ? 'This team needs a priority before an issue leaves triage.'
              : 'No priority yet. Press 1 to 4 to set one.'}
          </p>
        )}
      </div>
      {statuses.length > 0 && (
        <SelectField
          id="triage-accept-status"
          label="Status"
          value={chosen}
          onChange={(event) => {
            setStatusId(event.target.value);
          }}
        >
          {statuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </SelectField>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={saving || blocked}
        >
          Accept
        </Button>
      </div>
    </form>
  );
};

export default TriageAcceptForm;
