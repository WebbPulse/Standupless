/**
 * The API key settings page. Any member reaches it, because a person's own key
 * is theirs to mint; the workspace-wide listing and the workspace key kind are
 * the parts the section itself gates on an admin role, so the page does not
 * gate a second time in a place that could disagree with it.
 */

import React from 'react';
import ApiKeysSection from '../../components/access/ApiKeysSection';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';

/** Renders the API key list, the mint form and the one-time secret panel. */
const ApiKeysSettings: React.FC = () => {
  const { workspace } = useWorkspace();

  return (
    <WorkspaceShell>
      {workspace !== null && (
        <div className="space-y-8">
          <SettingsNav workspace={workspace} />
          <ApiKeysSection workspace={workspace} />
        </div>
      )}
    </WorkspaceShell>
  );
};

export default ApiKeysSettings;
