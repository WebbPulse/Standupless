/**
 * Adds a web link to an issue: the address and an optional title, which the
 * server fills from the page when it is left blank. It opens from the issue's
 * menu, the resources row, and Ctrl or Cmd L.
 */

import React, { useEffect, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { createUrlAttachment } from '../../api/discussion';
import { normalizeLinkUrl } from '../../lib/attachments';
import { errorMessage } from '../../lib/errors';
import { attachmentsKey } from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import Field from '../ui/field';

/** Props for AddLinkDialog. */
export interface AddLinkDialogProps {
  workspaceId: string;
  issueId: string;
  open: boolean;
  onClose: () => void;
}

/** The URL field's id, focused when the dialog opens. */
const URL_FIELD_ID = 'add-link-url';

/** The form inside the dialog, mounted fresh on each open so it starts empty. */
const AddLinkForm: React.FC<Omit<AddLinkDialogProps, 'open'>> = ({
  workspaceId,
  issueId,
  onClose,
}) => {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      document.getElementById(URL_FIELD_ID)?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  const href = normalizeLinkUrl(url);
  const invalid = touched && url.trim() !== '' && href === null;

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    setTouched(true);
    if (href === null || saving) return;
    setSaving(true);
    setFailure(null);
    const label = title.trim();
    createUrlAttachment(workspaceId, {
      issue_id: issueId,
      url: href,
      ...(label === '' ? {} : { title: label }),
    })
      .then(() => {
        invalidateQueries(attachmentsKey(issueId));
        showToast('Link added');
        onClose();
      })
      .catch((error: unknown) => {
        setFailure(error);
        setSaving(false);
      });
  };

  return (
    <form className="space-y-3" onSubmit={submit} noValidate>
      <Field
        id={URL_FIELD_ID}
        label="URL"
        type="url"
        inputMode="url"
        placeholder="https://"
        autoComplete="off"
        value={url}
        aria-invalid={invalid}
        {...(invalid
          ? { hint: 'Enter a web address, such as https://example.com.' }
          : {})}
        onChange={(event) => {
          setUrl(event.target.value);
        }}
        onBlur={() => {
          setTouched(true);
        }}
      />
      <Field
        id="add-link-title"
        label="Title"
        placeholder="Optional, read from the page when blank"
        autoComplete="off"
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
      />
      {failure !== null && (
        <ErrorAlert
          message={errorMessage(failure, 'Could not add that link.')}
        />
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={saving || href === null}
        >
          {saving ? 'Adding' : 'Add link'}
        </Button>
      </div>
    </form>
  );
};

/** The add link modal. */
export const AddLinkDialog: React.FC<AddLinkDialogProps> = ({
  open,
  ...props
}) => (
  <Dialog open={open} onClose={props.onClose} title="Add link" size="sm">
    {open && <AddLinkForm {...props} />}
  </Dialog>
);

export default AddLinkDialog;
