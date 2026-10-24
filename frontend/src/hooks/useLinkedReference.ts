/**
 * Reads whether a link in rendered Markdown names a project or document of the
 * open workspace, so the renderer can draw it as a chip and leave every other
 * link, including one to another workspace or deployment, as it was written.
 */

import { useContext } from 'react';
import { WorkspaceContext } from '../contexts/WorkspaceContextDefinition';
import {
  currentOrigin,
  linkedReference,
  type LinkedReference,
} from '../lib/references';

/** The project or document a link names in the open workspace, or null. */
export const useLinkedReference = (
  href: string,
  origin: string = currentOrigin()
): LinkedReference | null => {
  const workspace = useContext(WorkspaceContext)?.workspace ?? null;
  if (workspace === null) return null;
  const target = linkedReference(href, origin);
  return target !== null && target.slug === workspace.slug ? target : null;
};
