/**
 * Opens the create project and create initiative dialogs from anywhere in a
 * workspace, the way the command palette's "Create project" and "Create
 * initiative" reach them. The workspace layout renders the one dialog of each,
 * so a dialog opened from the palette stays open over whatever page is in
 * view. The `canCreate` flags mirror the API's rules: a project needs a team
 * the caller can write issues in, and an initiative needs a member, never a
 * guest.
 */

import { createContext, useContext } from 'react';

/** What {@link useCreatePlanning} hands back. */
export interface CreatePlanningState {
  /** Opens the create project dialog. Does nothing when the caller may not. */
  openProject: () => void;
  /** Opens the create initiative dialog. Does nothing when the caller may not. */
  openInitiative: () => void;
  /** Whether the caller can write issues in at least one team. */
  canCreateProject: boolean;
  /** Whether the caller's workspace role may create an initiative. */
  canCreateInitiative: boolean;
}

/** The dialog state the workspace layout provides, or null outside one. */
export const CreatePlanningContext = createContext<CreatePlanningState | null>(
  null
);

/** Dialogs that never open, for use outside a workspace. */
const UNAVAILABLE: CreatePlanningState = {
  openProject: () => undefined,
  openInitiative: () => undefined,
  canCreateProject: false,
  canCreateInitiative: false,
};

/** The workspace's create project and create initiative dialogs. */
export const useCreatePlanning = (): CreatePlanningState =>
  useContext(CreatePlanningContext) ?? UNAVAILABLE;

export default useCreatePlanning;
