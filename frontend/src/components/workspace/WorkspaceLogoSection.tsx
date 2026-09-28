/**
 * The workspace logo setting: the image the workspace switcher and the
 * workspace list show instead of the initials. Only an owner or an admin
 * reaches this page, which is what the icon routes check.
 */

import React from 'react';
import { uploadIcon, workspaceIcon } from '../../api/icons';
import { useWorkspace } from '../../hooks/useWorkspace';
import type { WorkspaceRead } from '../../types/Api';
import IconUploader from '../ui/icon-uploader';

/** Props for WorkspaceLogoSection. */
export interface WorkspaceLogoSectionProps {
  workspace: WorkspaceRead;
}

/** Uploads, replaces or removes the workspace logo, then re-reads the workspace. */
export const WorkspaceLogoSection: React.FC<WorkspaceLogoSectionProps> = ({
  workspace,
}) => {
  const { refresh } = useWorkspace();
  const owner = workspaceIcon(workspace.id);

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Logo</h3>
        <p className="text-sm text-text-muted">
          A square image works best. PNG, JPEG, GIF or WebP, up to 2 MB.
        </p>
      </div>
      <IconUploader
        label="Workspace logo"
        description="Shown in the workspace switcher and the workspace list."
        name={workspace.name}
        src={workspace.icon_url}
        shape="square"
        canEdit
        onUpload={async (file) => {
          await uploadIcon(owner, file);
          await refresh();
        }}
        onRemove={async () => {
          await owner.clear();
          await refresh();
        }}
      />
    </section>
  );
};

export default WorkspaceLogoSection;
