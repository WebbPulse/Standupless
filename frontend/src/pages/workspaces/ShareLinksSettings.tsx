/**
 * The share link settings page. Any member reaches it, and the server decides
 * what each one sees: a guest is answered only the links onto projects they can
 * read, so there is nothing for the page to filter on the caller's behalf.
 */

import React from 'react';
import ShareLinksSection from '../../components/access/ShareLinksSection';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';

/** Renders what this workspace has published publicly, and the revoke. */
const ShareLinksSettings: React.FC = () => {
  const { workspace } = useWorkspace();

  return (
    <WorkspaceShell>
      {workspace !== null && (
        <div className="space-y-8">
          <SettingsNav workspace={workspace} />
          <ShareLinksSection workspace={workspace} />
        </div>
      )}
    </WorkspaceShell>
  );
};

export default ShareLinksSettings;
