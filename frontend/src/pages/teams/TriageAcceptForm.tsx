/**
 * What the accept popover asks before an issue leaves triage: an optional
 * comment posted as the person accepting, and the status it lands in, which
 * defaults to the team's first unstarted one. Focus starts in the comment and
 * Enter confirms straight away, so the fast path stays one key plus Enter;
 * Shift+Enter breaks a line.
 *
 * The choice is one object so later fields, such as an assignee or a
 * priority, join it without changing how the page submits it.
 */

import React, { useState } from 'react';
import Button from '../../components/ui/button';
import { Textarea } from '../../components/ui/input';
import Label from '../../components/ui/label';
import { SelectField } from '../../components/ui/select';
import { defaultAcceptStatus } from '../../lib/triageActions';
import type { StatusRead } from '../../types/Api';

/** What an accept carries to the server. */
export interface TriageAcceptChoice {
  /** The status to accept into, or null for the server's default. */
  statusId: string | null;
  /** The comment to post, trimmed; empty posts none. */
  comment: string;
}

/** Props for TriageAcceptForm. */
export interface TriageAcceptFormProps {
  /** The issue's key, for the field labels. */
  issueKey: string;
  /** The team's visible statuses, ordered by position. */
  statuses: readonly StatusRead[];
  saving?: boolean;
  onSubmit: (choice: TriageAcceptChoice) => void;
  onCancel: () => void;
}

/** The accept popover's form. */
export const TriageAcceptForm: React.FC<TriageAcceptFormProps> = ({
  issueKey,
  statuses,
  saving = false,
  onSubmit,
  onCancel,
}) => {
  const fallback = defaultAcceptStatus(statuses);
  const [comment, setComment] = useState('');
  const [statusId, setStatusId] = useState<string | null>(null);
  const chosen = statusId ?? fallback?.id ?? '';

  const submit = (): void => {
    if (saving) return;
    onSubmit({
      statusId: chosen === '' ? null : chosen,
      comment: comment.trim(),
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
        <Button type="submit" variant="primary" size="sm" disabled={saving}>
          Accept
        </Button>
      </div>
    </form>
  );
};

export default TriageAcceptForm;
