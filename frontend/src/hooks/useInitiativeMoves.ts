/**
 * Reorders and timeline drags made on the initiatives page, shown before the
 * polled read catches up. A move lays its new place or dates over the
 * initiative at once, so the row lands where it was dropped; the stored
 * initiative replaces it when the write answers, and a newer read replaces
 * that. A failed write takes the move back and says so in a notice.
 */

import { useCallback, useState } from 'react';
import { invalidateQueries, type QueryKey } from '@webbpulse/api-client/react';
import { updateInitiative } from '../api/initiatives';
import { errorMessage } from '../lib/errors';
import { showErrorToast } from '../lib/toast';
import type { DateResolution, InitiativeRead } from '../types/Api';

/** The change one move writes: a new manual position, or new dates from the timeline. */
export interface InitiativeMove {
  sort_order?: string;
  start_date?: string | null;
  start_date_resolution?: DateResolution | null;
  target_date?: string | null;
  target_date_resolution?: DateResolution | null;
}

/** What useInitiativeMoves answers: the overlay and the move. */
export interface InitiativeMoves {
  /** The initiatives with every move still ahead of the read laid over them. */
  apply: (initiatives: readonly InitiativeRead[]) => InitiativeRead[];
  /** Moves one initiative, answering whether the write was stored. */
  move: (
    initiative: InitiativeRead,
    change: InitiativeMove
  ) => Promise<boolean>;
  /** Moves one initiative with no notice of its own, rejecting when the write fails, for undo. */
  put: (initiative: InitiativeRead, change: InitiativeMove) => Promise<void>;
}

/** Holds the list's moves over the polled initiatives. */
export const useInitiativeMoves = (
  workspaceId: string,
  refreshKey: QueryKey
): InitiativeMoves => {
  const [held, setHeld] = useState<Record<string, InitiativeRead>>({});

  const apply = useCallback(
    (initiatives: readonly InitiativeRead[]): InitiativeRead[] =>
      initiatives.map((initiative) => {
        const moved = held[initiative.initiative_id];
        return moved !== undefined && moved.updated_at >= initiative.updated_at
          ? moved
          : initiative;
      }),
    [held]
  );

  const forget = useCallback((initiativeId: string): void => {
    setHeld((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => key !== initiativeId)
      )
    );
  }, []);

  const put = useCallback(
    async (
      initiative: InitiativeRead,
      change: InitiativeMove
    ): Promise<void> => {
      const initiativeId = initiative.initiative_id;
      setHeld((current) => ({
        ...current,
        [initiativeId]: { ...initiative, ...change },
      }));
      try {
        const stored = await updateInitiative(
          workspaceId,
          initiativeId,
          change
        );
        setHeld((current) => ({ ...current, [initiativeId]: stored }));
        invalidateQueries(refreshKey);
      } catch (failure: unknown) {
        forget(initiativeId);
        throw failure;
      }
    },
    [workspaceId, refreshKey, forget]
  );

  const move = useCallback(
    (initiative: InitiativeRead, change: InitiativeMove): Promise<boolean> =>
      put(initiative, change)
        .then(() => true)
        .catch((failure: unknown) => {
          showErrorToast(
            errorMessage(
              failure,
              'Could not move that initiative. It has been undone.'
            )
          );
          return false;
        }),
    [put]
  );

  return { apply, move, put };
};

export default useInitiativeMoves;
