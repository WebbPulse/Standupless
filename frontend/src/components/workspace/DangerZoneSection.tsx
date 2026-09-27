/**
 * The workspace's danger zone: scheduling its deletion, and cancelling one that
 * is scheduled. Deletion waits out a grace period during which the workspace
 * keeps working and any owner or admin can cancel, so the scheduled state is a
 * banner with the date rather than a gone workspace.
 */

import React, { useState } from 'react';
import {
  cancelWorkspaceDeletion,
  scheduleWorkspaceDeletion,
} from '../../api/workspaces';
import { useWorkspace } from '../../hooks/useWorkspace';
import { DELETION_GRACE_DAYS, purgeDateLabel } from '../../lib/deletion';
import { errorMessage } from '../../lib/errors';
import type { WorkspaceRead } from '../../types/Api';
import ConfirmDeletionDialog from '../deletion/ConfirmDeletionDialog';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';

/** Props for DangerZoneSection: the workspace it acts on. */
export interface DangerZoneSectionProps {
  workspace: WorkspaceRead;
}

/** Schedules or cancels this workspace's deletion. */
export const DangerZoneSection: React.FC<DangerZoneSectionProps> = ({
  workspace,
}) => {
  const { refresh } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const scheduled =
    workspace.purge_after !== null && workspace.purge_after !== undefined;

  const cancel = async (): Promise<void> => {
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelWorkspaceDeletion(workspace.id);
      await refresh();
    } catch (error) {
      setCancelError(errorMessage(error, 'Could not cancel the deletion.'));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-danger">Danger zone</h2>
        <p className="text-sm text-text-muted">
          Actions here cannot be undone once their grace period ends.
        </p>
      </div>
      <ErrorAlert message={cancelError} />
      <div className="rounded-md border border-danger/30">
        {scheduled ? (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 px-3 py-3"
          >
            <div className="min-w-0 space-y-0.5 text-sm">
              <p className="font-medium text-text">
                This workspace will be permanently deleted on{' '}
                {purgeDateLabel(workspace.purge_after)}.
              </p>
              <p className="text-text-muted">
                It keeps working until then, and any owner or admin can cancel.
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void cancel()}
              disabled={cancelling}
            >
              Cancel deletion
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
            <div className="min-w-0 space-y-0.5 text-sm">
              <p className="font-medium text-text">Delete this workspace</p>
              <p className="text-text-muted">
                Schedules every team, issue, comment and attachment in it for
                permanent deletion after {DELETION_GRACE_DAYS} days.
              </p>
            </div>
            <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
              Delete workspace
            </Button>
          </div>
        )}
      </div>
      <ConfirmDeletionDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Delete ${workspace.name}`}
        confirmLabel={`Type ${workspace.name} to confirm`}
        expected={workspace.name}
        submitLabel="Schedule deletion"
        failureMessage="Could not schedule the deletion."
        onConfirm={async (typed) => {
          await scheduleWorkspaceDeletion(workspace.id, {
            confirm_name: typed,
          });
          await refresh();
        }}
      >
        <p>
          The workspace is deleted permanently after {DELETION_GRACE_DAYS} days.
          That takes its teams, issues, comments, attachments, views, share
          links, API keys, connected apps and the GitHub connection with it, and
          removes every member.
        </p>
        <p>
          Until then it keeps working, every owner and admin is emailed, and any
          of them can cancel from this page.
        </p>
      </ConfirmDeletionDialog>
    </section>
  );
};

export default DangerZoneSection;
