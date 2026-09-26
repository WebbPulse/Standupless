/**
 * Context object and type for the workspace's team list, kept apart from the
 * provider so the provider file exports only components and stays refresh safe.
 */

import { createContext } from 'react';
import type { TeamRead } from '../types/Api';

/** The one team list every surface under a workspace reads from. */
export interface TeamsContextType {
  /** The teams the caller can see, or null until the first read settles. */
  data: TeamRead[] | null;
  isLoading: boolean;
  error: unknown;
  /** Re-reads the list, for a create, a rename or a returning redirect. */
  refetch: () => Promise<void>;
}

/** Carries the shared team list to every page under `/w/:slug`. */
export const TeamsContext = createContext<TeamsContextType | undefined>(
  undefined
);
