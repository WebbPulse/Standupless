/**
 * Context object and type for the workspace the current route is scoped to,
 * kept apart from the provider so the provider file exports only components and
 * stays refresh safe.
 */

import { createContext } from 'react';
import type { WorkspaceRead } from '../types/Api';

/** The resolved workspace and the state of resolving it. */
export interface WorkspaceContextType {
  /** The workspace the slug resolved to, or null while resolving or on failure. */
  workspace: WorkspaceRead | null;
  /** True until the workspace list first settles. */
  isLoading: boolean;
  /** True once the list settled and held no workspace with this slug. */
  notFound: boolean;
  /** The failure that stopped the resolution, or null. */
  error: unknown;
  /** Re-reads the workspace list, for a rename or a membership change. */
  refresh: () => Promise<void>;
}

/** Carries the resolved workspace to every page under `/w/:slug`. */
export const WorkspaceContext = createContext<WorkspaceContextType | undefined>(
  undefined
);

/** The refetch key the workspace list is registered under. */
export const WORKSPACES_QUERY_KEY = 'workspaces';
