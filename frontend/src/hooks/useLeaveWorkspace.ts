/**
 * Opens the Leave workspace confirmation from the command palette, which
 * shares the one dialog the workspace layout renders.
 */

import { createContext, useContext } from 'react';

/** What {@link useLeaveWorkspace} hands back. */
export interface LeaveWorkspaceState {
  open: () => void;
}

/** The dialog state the workspace layout provides, or null outside one. */
export const LeaveWorkspaceContext = createContext<LeaveWorkspaceState | null>(
  null
);

/** The workspace's Leave workspace dialog, or null outside a workspace layout. */
export const useLeaveWorkspace = (): LeaveWorkspaceState | null =>
  useContext(LeaveWorkspaceContext);

export default useLeaveWorkspace;
