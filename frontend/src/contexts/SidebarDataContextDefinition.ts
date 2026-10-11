/**
 * Context object and type for the reads behind the workspace sidebar, kept
 * apart from the provider so the provider file exports only components and
 * stays refresh safe.
 */

import { createContext } from 'react';
import type { SavedViewDisplayRead } from '../api/views';
import type { ReviewsRead, TriageSummaryRead } from '../types/Api';

/**
 * The sidebar's reads, held above the pages so a navigation that mounts a new
 * sidebar renders the last known values instead of starting from nothing.
 */
export interface SidebarDataContextType {
  /** The workspace the reads belong to. */
  workspaceId: string;
  /** The triage count of every team with triage on, or null before the first read. */
  triage: TriageSummaryRead | null;
  /** Every saved view the caller can open, or null before the first read. */
  views: SavedViewDisplayRead[] | null;
  /** The caller's unread inbox count, or null before the first read. */
  inboxCount: number | null;
  /** The caller's Reviews list, or null before the first read. */
  reviews: ReviewsRead | null;
}

/** Carries the sidebar's reads to every page under `/w/:slug`. */
export const SidebarDataContext = createContext<
  SidebarDataContextType | undefined
>(undefined);
