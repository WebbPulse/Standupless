/**
 * Reorders made on the initiatives list, shown before the polled read
 * catches up. A move lays its new place over the initiative at once, so the
 * row lands where it was dropped; the stored initiative replaces it when the
 * write answers, and a newer read replaces that. A failed write takes the
 * move back and says so in a notice.
 */

import { useCallback, useState } from 'react';
import { invalidateQueries, type QueryKey } from '@webbpulse/api-client/react';
import { updateInitiative } from '../api/initiatives';
import { errorMessage } from '../lib/errors';
import { showErrorToast } from '../lib/toast';
import type { InitiativeRead } from '../types/Api';

/** The change one move writes: the initiative's new manual position. */
export interface InitiativeMove {
  sort_order: string;
}

/** What useInitiativeMoves answers: the overlay and the move. */
export interface InitiativeMoves {
  /** The initiatives with every move still ahead of the read laid over them. */
  apply: (initiatives: readonly InitiativeRead[]) => InitiativeRead[];
  /** Moves one initiative to a new manual position. */
  move: (initiative: InitiativeRead, change: InitiativeMove) => void;
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

  const move = useCallback(
    (initiative: InitiativeRead, change: InitiativeMove): void => {
      const initiativeId = initiative.initiative_id;
      setHeld((current) => ({
        ...current,
        [initiativeId]: { ...initiative, ...change },
      }));
      void updateInitiative(workspaceId, initiativeId, change)
        .then((stored) => {
          setHeld((current) => ({ ...current, [initiativeId]: stored }));
          invalidateQueries(refreshKey);
        })
        .catch((failure: unknown) => {
          forget(initiativeId);
          showErrorToast(
            errorMessage(
              failure,
              'Could not move that initiative. It has been undone.'
            )
          );
        });
    },
    [workspaceId, refreshKey, forget]
  );

  return { apply, move };
};

export default useInitiativeMoves;
