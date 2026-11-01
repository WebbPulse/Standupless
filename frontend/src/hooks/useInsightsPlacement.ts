/**
 * Whether a list's insights panel is open and how much room it has. A page that
 * remounts its list, as a saved view does each time it is saved, holds this
 * above the remount so saving from the panel does not close it.
 */

import { useCallback, useState } from 'react';

/** Where the insights panel stands beside its list. */
export interface InsightsPlacement {
  open: boolean;
  expanded: boolean;
  /** Opens or closes the panel, always back at its side of the list. */
  toggle: () => void;
  /** Grows the panel over the list or gives the room back. */
  toggleExpanded: () => void;
}

/** Holds one list's insights panel placement, closed until it is opened. */
export const useInsightsPlacement = (): InsightsPlacement => {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => {
    setOpen((was) => !was);
    setExpanded(false);
  }, []);
  const toggleExpanded = useCallback(() => {
    setExpanded((was) => !was);
  }, []);
  return { open, expanded, toggle, toggleExpanded };
};
