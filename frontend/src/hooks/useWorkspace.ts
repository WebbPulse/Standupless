/**
 * Accessor for the workspace the current route is scoped to, failing loudly
 * outside its provider.
 */

import { useContext } from 'react';
import {
  WorkspaceContext,
  type WorkspaceContextType,
} from '../contexts/WorkspaceContextDefinition';

/** Returns the resolved workspace, throwing outside a WorkspaceProvider. */
export const useWorkspace = (): WorkspaceContextType => {
  const value = useContext(WorkspaceContext);
  if (value === undefined) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return value;
};
