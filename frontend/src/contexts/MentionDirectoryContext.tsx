/**
 * Provides the workspace's mention directory, so a rendered `@handle` shows the
 * handle the person uses today even when the text was written before a rename.
 * Read from the workspace member list the pickers already share. Outside a
 * workspace the directory is empty and a mention renders as written. The
 * members behind the handles are provided too, so a mention opens a card with
 * the person's status.
 */

import React, { useMemo } from 'react';
import { useWorkspaceMembers } from '../hooks/useWorkspaceMembers';
import { mentionDirectory, mentionMembers } from '../lib/mentions';
import { MentionDirectoryContext } from './MentionDirectoryContextDefinition';
import { MentionMembersContext } from './MentionMembersContextDefinition';

/** Props for MentionDirectoryProvider: the workspace whose members name the handles. */
export interface MentionDirectoryProviderProps {
  workspaceId: string;
  children: React.ReactNode;
}

/** Builds the directory from the workspace's members and provides it. */
const MentionDirectoryProvider: React.FC<MentionDirectoryProviderProps> = ({
  workspaceId,
  children,
}) => {
  const members = useWorkspaceMembers(workspaceId);
  const directory = useMemo(() => mentionDirectory(members), [members]);
  const named = useMemo(() => mentionMembers(members), [members]);
  return (
    <MentionDirectoryContext.Provider value={directory}>
      <MentionMembersContext.Provider value={named}>
        {children}
      </MentionMembersContext.Provider>
    </MentionDirectoryContext.Provider>
  );
};

export default MentionDirectoryProvider;
