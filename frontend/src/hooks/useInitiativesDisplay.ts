/**
 * The initiatives page arrangement: ordering, whether completed initiatives
 * show, and which properties show. Each field reads from the URL first, so an
 * arranged page can be shared as a link, then from what the account saved, so
 * the page opens the way the person last left it on any device, then from the
 * built-in arrangement. A change writes the URL and saves the whole arrangement
 * to the account; the URL only carries fields that differ from the default.
 * Reset forgets the person's own arrangement.
 */

import { useCallback, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { useSearchParams } from 'react-router-dom';
import { updatePreferences } from '../api/notifications';
import {
  DEFAULT_INITIATIVES_DISPLAY,
  INITIATIVES_DISPLAY_FIELDS,
  resolveInitiativesDisplay,
  type InitiativesDisplay,
} from '../lib/initiativeList';
import { CURRENT_USER_KEY } from '../lib/queryKeys';
import { showErrorToast } from '../lib/toast';
import { useAuth } from './useAuth';

/** What useInitiativesDisplay answers: the arrangement and how to change it. */
export interface InitiativesDisplayState {
  display: InitiativesDisplay;
  /** Changes some fields, writing the URL and saving the whole arrangement. */
  change: (patch: Partial<InitiativesDisplay>) => void;
  /** Puts every field back to the default, or undefined when they already are. */
  reset: (() => void) | undefined;
}

/** What the person saved for themselves, `forgotten` once they reset it here. */
type Chosen = InitiativesDisplay | 'forgotten' | null;

/** Whether two arrangements hold the same choice in every field. */
const sameDisplay = (
  left: Partial<InitiativesDisplay> | undefined,
  right: InitiativesDisplay
): boolean =>
  left !== undefined &&
  INITIATIVES_DISPLAY_FIELDS.every((field) => left[field] === right[field]);

/** Reads and changes the initiatives page arrangement. */
export const useInitiativesDisplay = (): InitiativesDisplayState => {
  const [params, setParams] = useSearchParams();
  const { user, login } = useAuth();
  const [chosen, setChosen] = useState<Chosen>(null);
  const stored =
    user?.initiatives_display_saved === true
      ? user.initiatives_display
      : undefined;
  const own = chosen === 'forgotten' ? undefined : (chosen ?? stored);
  const display = resolveInitiativesDisplay(
    (field) => params.get(field),
    own ?? DEFAULT_INITIATIVES_DISPLAY
  );

  const save = useCallback(
    (next: InitiativesDisplay | null): void => {
      void updatePreferences({ initiatives_display: next })
        .then((answer) => {
          login(answer);
          invalidateQueries(CURRENT_USER_KEY);
        })
        .catch(() => {
          showErrorToast(
            next === null
              ? 'Could not reset this initiatives display on your account.'
              : 'Could not save this initiatives display to your account.'
          );
        });
    },
    [login]
  );

  const change = useCallback(
    (patch: Partial<InitiativesDisplay>): void => {
      const next = { ...display, ...patch };
      const query = new URLSearchParams(params);
      for (const field of INITIATIVES_DISPLAY_FIELDS) {
        if (next[field] === DEFAULT_INITIATIVES_DISPLAY[field])
          query.delete(field);
        else query.set(field, next[field]);
      }
      setParams(query, { replace: true });
      setChosen(next);
      if (user === null || sameDisplay(own, next)) return;
      save(next);
    },
    [display, params, setParams, user, own, save]
  );

  const forget = useCallback((): void => {
    const query = new URLSearchParams(params);
    for (const field of INITIATIVES_DISPLAY_FIELDS) query.delete(field);
    setParams(query, { replace: true });
    setChosen('forgotten');
    if (user !== null && own !== undefined) save(null);
  }, [params, setParams, user, own, save]);

  const reset =
    own === undefined && sameDisplay(display, DEFAULT_INITIATIVES_DISPLAY)
      ? undefined
      : forget;

  return { display, change, reset };
};

export default useInitiativesDisplay;
