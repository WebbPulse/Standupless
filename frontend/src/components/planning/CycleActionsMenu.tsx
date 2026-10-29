/**
 * The `...` menu in a cycle page's header, as Linear's cycle page carries:
 * copy the cycle's link, start it today when it is the team's next upcoming
 * cycle, end it today when it is running, cancel or restore it, and for a
 * team admin delete it. Starting, ending and deleting sit behind the same
 * confirms the team cycles page uses, a cancel or restore offers Undo once it
 * lands, and a delete returns to the team's cycles.
 */

import React, { useCallback, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import {
  LuBan,
  LuCalendarCheck,
  LuEllipsis,
  LuLink,
  LuPlay,
  LuRotateCcw,
  LuTrash2,
} from 'react-icons/lu';
import { useNavigate } from 'react-router-dom';
import {
  deleteCycle,
  endCycleToday,
  listCycles,
  startCycleToday,
  updateCycle,
} from '../../api/planning';
import {
  cycleNeighbours,
  deleteCycleMessage,
  endTodayMessage,
  startTodayMessage,
} from '../../lib/cycleActions';
import { cycleTitle } from '../../lib/cycleBreakdown';
import { copyText } from '../../lib/copyIssue';
import { errorMessage } from '../../lib/errors';
import { cyclePath, teamCyclesPath } from '../../lib/paths';
import { cyclesKey } from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import type { CycleRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button, { IconButton } from '../ui/button';
import Dialog from '../ui/dialog';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';

/** How often the team's cycles are re-read to place this one among them. */
const POLL_MS = 60000;

/** The confirm a menu item opens, or none. */
type Confirm = 'start' | 'end' | 'delete' | null;

/** What one confirm says and does. */
interface ConfirmCopy {
  heading: string;
  message: string;
  action: string;
  busyLabel: string;
  fallback: string;
  onConfirm: () => void;
  danger?: boolean;
}

/** Props for CycleActionsMenu: the cycle, its team and what the viewer may do. */
export interface CycleActionsMenuProps {
  workspaceId: string;
  slug: string;
  teamId: string;
  keyPrefix: string;
  /** The team's own cycle, without any sub-team roll-up. */
  cycle: CycleRead;
  canEdit: boolean;
  isAdmin: boolean;
  /** Re-reads everything the page shows after an action lands. */
  onChanged: () => void;
}

/** The cycle page header's actions menu and the confirms it opens. */
export const CycleActionsMenu: React.FC<CycleActionsMenuProps> = ({
  workspaceId,
  slug,
  teamId,
  keyPrefix,
  cycle,
  canEdit,
  isAdmin,
  onChanged,
}) => {
  const auth = useQueryAuth();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      listCycles(workspaceId, { team_id: teamId }, signal),
    [workspaceId, teamId]
  );
  const { data } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: canEdit && teamId !== '' && cycle.status === 'upcoming',
    queryKey: cyclesKey(workspaceId, teamId, ''),
    auth,
  });
  const { current, next } = cycleNeighbours(data?.cycles ?? []);

  const title = cycleTitle(cycle);
  const mayStart =
    canEdit && cycle.status === 'upcoming' && next?.cycle_id === cycle.cycle_id;
  const mayEnd = canEdit && cycle.status === 'active';
  const path = cyclePath(slug, keyPrefix, cycle.cycle_id);

  const close = useCallback((): void => {
    setConfirm(null);
    setFailure(null);
  }, []);

  const run = useCallback(
    async (action: () => Promise<unknown>, after?: () => void) => {
      setIsBusy(true);
      setFailure(null);
      try {
        await action();
        setConfirm(null);
        onChanged();
        after?.();
      } catch (caught: unknown) {
        setFailure(caught);
      } finally {
        setIsBusy(false);
      }
    },
    [onChanged]
  );

  const setCancelled = useCallback(
    (cancelled: boolean) =>
      updateCycle(workspaceId, cycle.cycle_id, { team_id: teamId, cancelled }),
    [workspaceId, cycle.cycle_id, teamId]
  );

  const toggleCancelled = (): void => {
    const cancelled = !cycle.cancelled;
    void setCancelled(cancelled)
      .then(() => {
        onChanged();
        showToast(`${title} ${cancelled ? 'cancelled' : 'restored'}`, 'info', {
          action: {
            label: 'Undo',
            run: () => {
              void setCancelled(!cancelled)
                .then(onChanged)
                .catch(() => {
                  showErrorToast('Could not undo that change.');
                });
            },
          },
        });
      })
      .catch((caught: unknown) => {
        showErrorToast(
          errorMessage(
            caught,
            cancelled
              ? 'Could not cancel that cycle.'
              : 'Could not restore that cycle.'
          )
        );
      });
  };

  const confirmDialog = ({
    heading,
    message,
    action,
    busyLabel,
    fallback,
    onConfirm,
    danger = false,
  }: ConfirmCopy): React.ReactNode => (
    <Dialog open title={heading} onClose={close} size="sm">
      <div className="space-y-4">
        {failure !== null && (
          <ErrorAlert message={errorMessage(failure, fallback)} />
        )}
        <p className="text-sm text-text-muted">{message}</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={isBusy}
            onClick={onConfirm}
          >
            {isBusy ? busyLabel : action}
          </Button>
        </div>
      </div>
    </Dialog>
  );

  return (
    <>
      <Menu
        label={`${title} actions`}
        align="end"
        trigger={(trigger) => (
          <IconButton label={`${title} actions`} {...trigger}>
            <LuEllipsis className="h-4 w-4" />
          </IconButton>
        )}
      >
        <MenuItem
          onSelect={() => {
            copyText(
              new URL(path, globalThis.location.origin).toString(),
              'Link to the cycle copied'
            );
          }}
        >
          <LuLink aria-hidden="true" className="h-3.5 w-3.5" />
          Copy link
        </MenuItem>
        {(canEdit || isAdmin) && <MenuSeparator />}
        {mayStart && (
          <MenuItem
            onSelect={() => {
              setConfirm('start');
            }}
          >
            <LuPlay aria-hidden="true" className="h-3.5 w-3.5" />
            Start cycle today
          </MenuItem>
        )}
        {mayEnd && (
          <MenuItem
            onSelect={() => {
              setConfirm('end');
            }}
          >
            <LuCalendarCheck aria-hidden="true" className="h-3.5 w-3.5" />
            End cycle today
          </MenuItem>
        )}
        {canEdit && (
          <MenuItem onSelect={toggleCancelled}>
            {cycle.cancelled ? (
              <LuRotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <LuBan aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            {cycle.cancelled ? 'Restore cycle' : 'Cancel cycle'}
          </MenuItem>
        )}
        {isAdmin && (
          <MenuItem
            danger
            onSelect={() => {
              setConfirm('delete');
            }}
          >
            <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
            Delete cycle
          </MenuItem>
        )}
      </Menu>

      {confirm === 'start' &&
        confirmDialog({
          heading: 'Start cycle today',
          message: startTodayMessage(cycle, current),
          action: `Start ${title}`,
          busyLabel: 'Starting',
          fallback: 'Could not start that cycle.',
          onConfirm: () => {
            void run(() =>
              startCycleToday(workspaceId, cycle.cycle_id, teamId)
            );
          },
        })}

      {confirm === 'end' &&
        confirmDialog({
          heading: 'End cycle today',
          message: endTodayMessage(cycle),
          action: `End ${title} today`,
          busyLabel: 'Ending',
          fallback: 'Could not end that cycle.',
          onConfirm: () => {
            void run(() => endCycleToday(workspaceId, cycle.cycle_id, teamId));
          },
        })}

      {confirm === 'delete' &&
        confirmDialog({
          heading: 'Delete cycle',
          message: deleteCycleMessage(cycle),
          action: `Delete ${title}`,
          busyLabel: 'Deleting',
          fallback: 'Could not delete that cycle.',
          danger: true,
          onConfirm: () => {
            void run(
              () => deleteCycle(workspaceId, cycle.cycle_id, teamId),
              () => {
                void navigate(teamCyclesPath(slug, keyPrefix));
              }
            );
          },
        })}
    </>
  );
};

export default CycleActionsMenu;
