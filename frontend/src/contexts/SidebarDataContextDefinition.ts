/**
 * Context object and type for the reads behind the workspace sidebar, kept
 * apart from the provider so the provider file exports only components and
 * stays refresh safe.
 */

import { createContext } from 'react';
import type { SavedViewDisplayRead } from '../api/views';
import type { FavoritesState } from '../lib/favorites';
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
  /** The caller's unread Pulse count, or null before the first read. */
  pulseCount: number | null;
  /** The caller's favorites and the writes that change them. */
  favorites: FavoritesState;
}

/** Carries the sidebar's reads to every page under `/w/:slug`. */
export const SidebarDataContext = createContext<
  SidebarDataContextType | undefined
>(undefined);

/** The set every view reads before the triage summary arrives or outside a workspace. */
export const NO_TRIAGE_TEAMS: ReadonlySet<string> = new Set();

/**
 * The ids of the teams with triage on, apart from the rest of the sidebar's
 * reads. The set keeps its identity until a team turns triage on or off, so
 * the status cell on every list row reads it without rendering again each
 * time a triage count, the inbox badge or the view list is re-read.
 */
export const TriageTeamsContext =
  createContext<ReadonlySet<string>>(NO_TRIAGE_TEAMS);
