/**
 * What the accept popover asks before an issue leaves triage: an optional
 * comment posted as the person accepting, and the status it lands in, which
 * defaults to the team's first unstarted one. Focus starts in the comment and
 * Enter confirms straight away, so the fast path stays one key plus Enter;
 * Shift+Enter breaks a line.
 *
 * When the team requires a priority before an issue leaves triage and the
 * issue has none, the form also asks for one and holds the accept until it is
 * picked, so the server's refusal is never the first the person hears of it.
 *
 * The choice is one object so later fields, such as an assignee, join it
 * without changing how the page submits it.
 */

import React, { useState } from 'react';
import Button from '../../components/ui/button';
import { Textarea } from '../../components/ui/input';
import Label from '../../components/ui/label';
import { SelectField } from '../../components/ui/select';
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

/** The priorities an accept may set, every one but none. */
const PICKABLE = PRIORITIES.filter((priority) => priority !== 'none');

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
  const [picked, setPicked] = useState<IssuePriority | ''>('');
  const chosen = statusId ?? fallback?.id ?? '';
  const asksPriority = requirePriority && priority === 'none';
  const blocked = asksPriority && picked === '';

  const submit = (): void => {
    if (saving || blocked) return;
    onSubmit({
      statusId: chosen === '' ? null : chosen,
      comment: comment.trim(),
      priority: picked === '' ? null : picked,
    });
  };

  return (
    <form
      aria-label={`Accept ${issueKey}`}
      className="w-72 max-w-full space-y-3 p-3"
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
      {asksPriority && (
        <SelectField
          id="triage-accept-priority"
          label="Priority"
          aria-describedby="triage-accept-priority-hint"
          value={picked}
          onChange={(event) => {
            setPicked(event.target.value as IssuePriority | '');
          }}
        >
          <option value="" disabled>
            Choose a priority
          </option>
          {PICKABLE.map((option) => (
            <option key={option} value={option}>
              {PRIORITY_LABELS[option]}
            </option>
          ))}
        </SelectField>
      )}
      {asksPriority && (
        <p id="triage-accept-priority-hint" className="text-xs text-text-muted">
          This team needs a priority before an issue leaves triage.
        </p>
      )}
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
