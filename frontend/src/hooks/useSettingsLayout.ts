/**
 * Whether the page in view sits under the settings layout route, which is how
 * the workspace shell knows to show the grouped settings sidebar in place of
 * the app sidebar. Each page still renders its own shell, so the layout route
 * says so through context rather than rendering the frame itself.
 */

import { createContext, useContext } from 'react';

/** True under the settings layout route, false everywhere else. */
export const SettingsLayoutContext = createContext(false);

/** Whether the page in view is a settings page. */
export const useInSettings = (): boolean => useContext(SettingsLayoutContext);
