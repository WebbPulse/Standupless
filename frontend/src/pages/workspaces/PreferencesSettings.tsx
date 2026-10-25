/**
 * The personal Preferences page, under Settings > Account: the default home
 * view, the first day of the week, how people's names read, the text size and
 * the theme. These belong to the person rather than the workspace, so a change
 * here applies in every workspace they belong to.
 */

import React from 'react';
import PreferencesSection from '../../components/account/PreferencesSection';
import { SettingsAnchor } from '../../components/workspace/SettingsSearch';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';

/** Renders the caller's interface preferences. */
const PreferencesSettings: React.FC = () => {
  const { workspace } = useWorkspace();

  return (
    <WorkspaceShell title="Settings">
      {workspace !== null && (
        <div className="max-w-2xl space-y-8">
          <SettingsAnchor id="preferences">
            <PreferencesSection />
          </SettingsAnchor>
        </div>
      )}
    </WorkspaceShell>
  );
};

export default PreferencesSettings;
