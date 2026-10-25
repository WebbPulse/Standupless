/**
 * The Status section of the Profile page: the status the person has set in
 * this workspace, with buttons to change or clear it. It edits the same row the
 * avatar menu does, through the same dialog, so both ways of setting it agree.
 * A status belongs to the workspace it is set in, unlike the rest of the page.
 */

import React, { useState } from 'react';
import { useMyStatus } from '../../hooks/useMyStatus';
import { awayNote, statusUntilLabel } from '../../lib/userStatus';
import UserStatusDialog from '../workspace/UserStatusDialog';
import Button from '../ui/button';

/** Props for StatusSection. */
export interface StatusSectionProps {
  workspaceId: string;
}

/** Shows and edits the caller's status in `workspaceId`. */
export const StatusSection: React.FC<StatusSectionProps> = ({
  workspaceId,
}) => {
  const control = useMyStatus(workspaceId);
  const [open, setOpen] = useState(false);
  const status = control.status;
  const away = awayNote(status);

  return (
    <section className="space-y-4" aria-labelledby="status-title">
      <div className="space-y-1">
        <h2 id="status-title" className="text-base font-semibold">
          Status
        </h2>
        <p className="text-sm text-text-muted">
          Shown beside your name in this workspace. Marking yourself away adds a
          note wherever you are assigned or mentioned. Notifications keep
          arriving.
        </p>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border border-line p-4">
        <div className="min-w-0 text-sm" data-testid="status-current">
          {status === null ? (
            <span className="text-text-muted">No status set</span>
          ) : (
            <>
              <p className="flex items-center gap-1.5 text-text">
                {status.emoji !== '' && (
                  <span aria-hidden="true">{status.emoji}</span>
                )}
                <span className="truncate">
                  {status.text || (status.away ? 'Away' : '')}
                </span>
              </p>
              {away !== null ? (
                <p className="text-xs text-warning">{away}</p>
              ) : (
                status.until && (
                  <p className="text-xs text-text-muted">
                    Clears {statusUntilLabel(status.until)}
                  </p>
                )
              )}
            </>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {status !== null && (
            <Button
              variant="ghost"
              size="sm"
              disabled={control.saving}
              onClick={() => void control.clear()}
            >
              Clear
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setOpen(true);
            }}
          >
            {status === null ? 'Set status' : 'Edit status'}
          </Button>
        </div>
      </div>
      <UserStatusDialog
        open={open}
        control={control}
        onClose={() => {
          setOpen(false);
        }}
      />
    </section>
  );
};

export default StatusSection;
