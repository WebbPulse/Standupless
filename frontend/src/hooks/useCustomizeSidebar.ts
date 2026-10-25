/**
 * Opens the Customize sidebar dialog from the workspace menu, a sidebar item's
 * right-click menu and the command palette, which all share the one dialog the
 * workspace layout renders.
 */

import { createContext, useContext } from 'react';

/** What {@link useCustomizeSidebar} hands back. */
export interface CustomizeSidebarState {
  open: () => void;
}

/** The dialog state the workspace layout provides, or null outside one. */
export const CustomizeSidebarContext =
  createContext<CustomizeSidebarState | null>(null);

const UNAVAILABLE: CustomizeSidebarState = { open: () => undefined };

/** The workspace's Customize sidebar dialog. */
export const useCustomizeSidebar = (): CustomizeSidebarState =>
  useContext(CustomizeSidebarContext) ?? UNAVAILABLE;

export default useCustomizeSidebar;
