/**
 * Context object for the workspace's mention directory, kept apart from the
 * provider so the provider file exports only components and stays refresh safe.
 */

import { createContext, useContext } from 'react';

/** The handle every known handle renders as, keyed by the lowercased handle. */
export const MentionDirectoryContext = createContext<
  ReadonlyMap<string, string>
>(new Map());

/** The handle a mention written as `handle` renders as. */
export const useMentionLabel = (handle: string): string =>
  useContext(MentionDirectoryContext).get(handle.toLowerCase()) ?? handle;
