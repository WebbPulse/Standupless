/**
 * Renames one issue from a list, opened by R on the focused row. The field
 * starts with the title selected, Enter saves a changed title and Escape
 * closes without writing, the same rules the issue page's title follows.
 */

import React, { useState } from 'react';
import { validateTitle } from '../../lib/validation';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import Field from '../ui/field';

/** Props for RenameIssueDialog. */
export interface RenameIssueDialogProps {
  /** The issue's key, named in the description. */
  issueKey: string;
  title: string;
  /** Writes the new title. Called only for a changed, valid title. */
  onRename: (title: string) => void;
  onClose: () => void;
}

/** The title field's id. */
const FIELD_ID = 'rename-issue-title';

/** The rename modal. */
export const RenameIssueDialog: React.FC<RenameIssueDialogProps> = ({
  issueKey,
  title,
  onRename,
  onClose,
}) => {
  const [draft, setDraft] = useState(title);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const next = draft.replace(/\s*\n\s*/g, ' ').trim();
    if (next === '' || next === title) {
      onClose();
      return;
    }
    const invalid = validateTitle(next);
    if (invalid !== null) {
      setProblem(invalid);
      return;
    }
    onRename(next);
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Rename issue"
      description={`A new title for ${issueKey}.`}
      size="sm"
    >
      <form onSubmit={submit} noValidate className="space-y-3">
        <Field
          id={FIELD_ID}
          label="Title"
          hideLabel
          value={draft}
          aria-invalid={problem !== null}
          {...(problem === null ? {} : { hint: problem })}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
          onChange={(event) => {
            setDraft(event.target.value);
            setProblem(null);
          }}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" variant="primary">
            Rename
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

export default RenameIssueDialog;
