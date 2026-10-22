/**
 * The projects page arrangement: layout, grouping, ordering, which completed
 * projects stay, and the timeline zoom. Each field reads from the URL first,
 * so an arranged page can be shared as a link, then from what the account
 * saved, so the page opens the way the person last left it on any device,
 * then from the default. A change writes the URL and saves the whole
 * arrangement to the account; the URL only carries fields that differ from
 * the default, so a plain link stays plain.
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

/** Whether two arrangements hold the same choice in every field. */
const sameDisplay = (
  left: Partial<ProjectsDisplay> | undefined,
  right: ProjectsDisplay
): boolean =>
  left !== undefined &&
  PROJECTS_DISPLAY_FIELDS.every((field) => left[field] === right[field]);

/** Reads and changes the projects page arrangement. */
export const useProjectsDisplay = (): ProjectsDisplayState => {
  const [params, setParams] = useSearchParams();
  const { user, login } = useAuth();
  const [chosen, setChosen] = useState<ProjectsDisplay | null>(null);
  const saved = chosen ?? user?.projects_display;
  const display = resolveDisplay((field) => params.get(field), saved);

  const change = useCallback(
    (patch: Partial<ProjectsDisplay>): void => {
      const next = { ...display, ...patch };
      const query = new URLSearchParams(params);
      for (const field of PROJECTS_DISPLAY_FIELDS) {
        if (next[field] === DEFAULT_PROJECTS_DISPLAY[field])
          query.delete(field);
        else query.set(field, next[field]);
      }
      setChosen(next);
      setParams(query, { replace: true });
      if (user === null || sameDisplay(user.projects_display, next)) return;
      void updatePreferences({ projects_display: next })
        .then((stored) => {
          login(stored);
          invalidateQueries(CURRENT_USER_KEY);
        })
        .catch(() => {
          showErrorToast(
            'Could not save this projects display to your account.'
          );
        });
    },
    [display, params, setParams, user, login]
  );

  const reset = sameDisplay(display, DEFAULT_PROJECTS_DISPLAY)
    ? undefined
    : () => {
        change(DEFAULT_PROJECTS_DISPLAY);
      };

  return { display, change, reset };
};

export default useProjectsDisplay;
