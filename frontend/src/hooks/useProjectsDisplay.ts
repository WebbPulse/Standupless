/**
 * The projects page arrangement: layout, grouping, ordering, which completed
 * projects stay, and the timeline zoom. Each field reads from the URL first,
 * so an arranged page can be shared as a link, then from what the account
 * saved, so the page opens the way the person last left it on any device,
 * then from the default an admin set for everyone (the team's on a team
 * page, else the workspace's), then from the built-in arrangement. A change
 * writes the URL and saves the whole arrangement to the account; the URL only
 * carries fields that differ from the default, so a plain link stays plain.
 * Reset forgets the person's own arrangement, so the page opens with the
 * default for everyone again. Handed a saved view's
 * arrangement as the base, the page reads from that instead of the account,
 * the URL carries only what differs from the view, and nothing is saved to
 * the account, so arranging a view never moves the person's own projects page.
 */

import { useCallback, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { useSearchParams } from 'react-router-dom';
import { updatePreferences } from '../api/notifications';
import {
  DEFAULT_PROJECTS_DISPLAY,
  PROJECTS_DISPLAY_FIELDS,
  resolveDisplay,
  type ProjectsDisplay,
} from '../lib/projectList';
import { CURRENT_USER_KEY } from '../lib/queryKeys';
import { showErrorToast } from '../lib/toast';
import { useAuth } from './useAuth';

/** What useProjectsDisplay answers: the arrangement and how to change it. */
export interface ProjectsDisplayState {
  display: ProjectsDisplay;
  /** Changes some fields, writing the URL and saving the whole arrangement. */
  change: (patch: Partial<ProjectsDisplay>) => void;
  /** Puts every field back to the default, or undefined when they already are. */
  reset: (() => void) | undefined;
}

/** What the person saved for themselves, `forgotten` once they reset it here. */
type Chosen = ProjectsDisplay | 'forgotten' | null;

/** Whether two arrangements hold the same choice in every field. */
const sameDisplay = (
  left: Partial<ProjectsDisplay> | undefined,
  right: ProjectsDisplay
): boolean =>
  left !== undefined &&
  PROJECTS_DISPLAY_FIELDS.every((field) => left[field] === right[field]);

/**
 * Reads and changes the projects page arrangement, over a saved view's when
 * `base` is given, and over `fallback`, the default an admin set for
 * everyone, for a person who never arranged the page.
 */
export const useProjectsDisplay = (
  base?: ProjectsDisplay,
  fallback: ProjectsDisplay = DEFAULT_PROJECTS_DISPLAY
): ProjectsDisplayState => {
  const [params, setParams] = useSearchParams();
  const { user, login } = useAuth();
  const [chosen, setChosen] = useState<Chosen>(null);
  const stored =
    user?.projects_display_saved === false ? undefined : user?.projects_display;
  const own = chosen === 'forgotten' ? undefined : (chosen ?? stored);
  const saved = base ?? own ?? fallback;
  const display = resolveDisplay((field) => params.get(field), saved);
  const plain = base ?? fallback;

  const save = useCallback(
    (next: ProjectsDisplay | null): void => {
      void updatePreferences({ projects_display: next })
        .then((answer) => {
          login(answer);
          invalidateQueries(CURRENT_USER_KEY);
        })
        .catch(() => {
          showErrorToast(
            next === null
              ? 'Could not reset this projects display on your account.'
              : 'Could not save this projects display to your account.'
          );
        });
    },
    [login]
  );

  const change = useCallback(
    (patch: Partial<ProjectsDisplay>): void => {
      const next = { ...display, ...patch };
      const query = new URLSearchParams(params);
      for (const field of PROJECTS_DISPLAY_FIELDS) {
        if (next[field] === plain[field]) query.delete(field);
        else query.set(field, next[field]);
      }
      setParams(query, { replace: true });
      if (base !== undefined) return;
      setChosen(next);
      if (user === null || sameDisplay(own, next)) return;
      save(next);
    },
    [display, params, setParams, user, base, plain, own, save]
  );

  const forget = useCallback((): void => {
    const query = new URLSearchParams(params);
    for (const field of PROJECTS_DISPLAY_FIELDS) query.delete(field);
    setParams(query, { replace: true });
    setChosen('forgotten');
    if (user !== null && own !== undefined) save(null);
  }, [params, setParams, user, own, save]);

  const reset =
    base !== undefined
      ? sameDisplay(display, DEFAULT_PROJECTS_DISPLAY)
        ? undefined
        : () => {
            change(DEFAULT_PROJECTS_DISPLAY);
          }
      : own === undefined && sameDisplay(display, fallback)
        ? undefined
        : forget;

  return { display, change, reset };
};

export default useProjectsDisplay;
