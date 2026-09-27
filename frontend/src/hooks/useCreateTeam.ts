/**
 * Opens the create team dialog from the sidebar, the command palette, the
 * settings Teams page and the workspace home, all of which share the one
 * dialog the workspace layout renders. `canCreate` mirrors the API's rule
 * (owners, admins and members, never guests) so no surface offers a control
 * the server would refuse.
 */

import { createContext, useContext } from 'react';

/** What {@link useCreateTeam} hands back. */
export interface CreateTeamState {
  /** Opens the dialog. Does nothing when the caller may not create teams. */
  open: () => void;
  /** Whether the caller's workspace role may create a team. */
  canCreate: boolean;
}

/** The dialog state the workspace layout provides, or null outside one. */
export const CreateTeamContext = createContext<CreateTeamState | null>(null);

/** A dialog that never opens, for use outside a workspace. */
const UNAVAILABLE: CreateTeamState = {
  open: () => undefined,
  canCreate: false,
};

/** The workspace's create team dialog. */
export const useCreateTeam = (): CreateTeamState =>
  useContext(CreateTeamContext) ?? UNAVAILABLE;

export default useCreateTeam;
