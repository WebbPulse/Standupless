/**
 * The dialog that hands a dashboard or a saved view to another member: a
 * member picker and a confirm, shared so both surfaces ask the same way.
 */

import React, { useState } from 'react';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import { Select } from '../ui/select';
import type { MemberRead } from '../../types/Api';

/** Props for ChangeOwnerDialog. */
export interface ChangeOwnerDialogProps {
  /** The current owner, picked when the dialog opens. */
  ownerId: string;
  members: MemberRead[];
  /** What owning the thing means, or why it cannot change hands yet. */
  description: string;
  /** Keeps the picker and confirm off, for a thing that cannot change hands. */
  locked?: boolean;
  onClose: () => void;
  /** Saves the new owner, resolving true once it is saved. */
  onSubmit: (ownerId: string) => Promise<boolean>;
}

/** Picks a new owner and saves it, closing on success. */
export const ChangeOwnerDialog: React.FC<ChangeOwnerDialogProps> = ({
  ownerId,
  members,
  description,
  locked = false,
  onClose,
  onSubmit,
}) => {
  const [owner, setOwner] = useState(ownerId);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      if (await onSubmit(owner)) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Change owner"
      description={description}
      size="sm"
    >
      <div className="flex flex-col gap-3">
        <Select
          aria-label="Owner"
          value={owner}
          disabled={locked}
          onChange={(event) => {
            setOwner(event.target.value);
          }}
        >
          {members.map((member) => (
            <option key={member.user_id} value={member.user_id}>
              {member.display_name ?? member.email}
            </option>
          ))}
        </Select>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || locked || owner === '' || owner === ownerId}
            onClick={() => void submit()}
          >
            Change owner
          </Button>
        </div>
      </div>
    </Dialog>
  );
};

export default ChangeOwnerDialog;
