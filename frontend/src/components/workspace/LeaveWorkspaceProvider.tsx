/**
 * Holds the workspace layout's one Leave workspace confirmation and hands its
 * opener to everything beneath, so the command palette, which unmounts as it
 * closes, can open a dialog that outlives it.
 */

import React, { useMemo, useState } from 'react';
import {
  LeaveWorkspaceContext,
  type LeaveWorkspaceState,
} from '../../hooks/useLeaveWorkspace';
import { useWorkspace } from '../../hooks/useWorkspace';
import LeaveWorkspaceDialog from './LeaveWorkspaceDialog';

/** Supplies the Leave workspace opener and renders its dialog. */
export const LeaveWorkspaceProvider: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const { workspace } = useWorkspace();
  const [open, setOpen] = useState(false);
  const value = useMemo<LeaveWorkspaceState>(
    () => ({
      open: () => {
        setOpen(true);
      },
    }),
    []
  );

  return (
    <LeaveWorkspaceContext.Provider value={value}>
      {children}
      {workspace !== null && (
        <LeaveWorkspaceDialog
          open={open}
          workspace={workspace}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </LeaveWorkspaceContext.Provider>
  );
};

export default LeaveWorkspaceProvider;
