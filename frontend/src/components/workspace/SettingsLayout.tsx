/**
 * The layout route every settings page renders under, workspace, account and
 * team alike. It marks its pages as settings, so the shell swaps the app
 * sidebar for the grouped settings sidebar, and binds Escape to leave
 * settings for the last page shown outside them, as Linear's does. The URLs
 * of the pages under it are unchanged, since the route has no path of its own.
 */

import React from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { SettingsLayoutContext } from '../../hooks/useSettingsLayout';
import { useShortcut } from '../../hooks/useShortcuts';
import { useWorkspace } from '../../hooks/useWorkspace';
import { settingsReturnPath } from '../../lib/settingsReturn';

/** Renders the settings page in view and the shortcut that leaves settings. */
export const SettingsLayout: React.FC = () => {
  const navigate = useNavigate();
  const { workspace } = useWorkspace();
  const slug = workspace?.slug ?? '';

  useShortcut({
    keys: 'escape',
    label: 'Back to app',
    group: 'Settings',
    enabled: slug !== '',
    handler: () => {
      void navigate(settingsReturnPath(slug));
    },
  });

  return (
    <SettingsLayoutContext.Provider value={true}>
      <Outlet />
    </SettingsLayoutContext.Provider>
  );
};

export default SettingsLayout;
