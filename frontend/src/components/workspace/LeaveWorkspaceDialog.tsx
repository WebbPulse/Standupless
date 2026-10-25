/**
 * The confirmation in front of leaving a workspace, shared by the settings
 * danger zone, the workspace picker and the command palette. It names the
 * workspace, refuses up front when the caller is its last owner, as the API
 * would, and shows any other refusal inline. Once the caller has left, the
 * workspace is forgotten as the one to resume, every cached read is dropped and
 * the workspace list is read again, so the switcher no longer offers it.
 */

import React, { useState } from 'react';
import {
  clearPolledQueryCache,
  invalidateQueries,
} from '@webbpulse/api-client/react';
import { useNavigate } from 'react-router-dom';
import { removeMember } from '../../api/workspaces';
import { useAuth } from '../../hooks/useAuth';
import { lastOwnerReason, useLastOwner } from '../../hooks/useLastOwner';
import { errorMessage } from '../../lib/errors';
import { forgetWorkspace } from '../../lib/lastWorkspace';
import { WORKSPACES_PATH } from '../../lib/paths';
import { WORKSPACES_KEY } from '../../lib/queryKeys';
import type { WorkspaceRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Dialog from '../ui/dialog';

/** Props for LeaveWorkspaceDialog. */
export interface LeaveWorkspaceDialogProps {
  open: boolean;
  onClose: () => void;
  workspace: Pick<WorkspaceRead, 'id' | 'slug' | 'name' | 'role'>;
  /** Runs once the caller has left; without it the picker opens. */
  onLeft?: () => void;
}

/** Confirms and sends the caller's own removal from a workspace. */
export const LeaveWorkspaceDialog: React.FC<LeaveWorkspaceDialogProps> = ({
  open,
  onClose,
  workspace,
  onLeft,
}) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { lastOwner, checking } = useLastOwner(workspace, open);
  const [leaving, setLeaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const userId = user?.id;

  const close = (): void => {
    if (leaving) return;
    setFailure(null);
    onClose();
  };

  const leave = async (): Promise<void> => {
    if (userId === undefined || lastOwner || checking || leaving) return;
    setLeaving(true);
    setFailure(null);
    try {
      await removeMember(workspace.id, userId);
    } catch (error) {
      setFailure(errorMessage(error, 'Could not leave the workspace.'));
      setLeaving(false);
      return;
    }
    setLeaving(false);
    forgetWorkspace(workspace.slug);
    onClose();
    if (onLeft === undefined) {
      void navigate(WORKSPACES_PATH, { replace: true });
    } else {
      onLeft();
    }
    clearPolledQueryCache();
    invalidateQueries(WORKSPACES_KEY);
  };

  return (
    <Dialog open={open} onClose={close} title={`Leave ${workspace.name}`}>
      <div className="space-y-4">
        <div className="space-y-2 text-sm text-text-muted">
          <p>
            You lose access to every team, issue and document in{' '}
            {workspace.name}. To come back, an admin has to invite you again.
          </p>
          {lastOwner && <p role="status">{lastOwnerReason(workspace.name)}</p>}
        </div>
        <ErrorAlert message={failure} />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={close}
            disabled={leaving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => void leave()}
            disabled={userId === undefined || lastOwner || checking || leaving}
          >
            Leave workspace
          </Button>
        </div>
      </div>
    </Dialog>
  );
};

export default LeaveWorkspaceDialog;
