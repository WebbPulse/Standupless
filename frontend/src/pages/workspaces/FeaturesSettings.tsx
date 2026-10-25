/**
 * The workspace Features settings page, where an owner or admin turns the
 * optional areas on and off: initiatives, customers, releases, documents and
 * Pulse. Turning one off hides it everywhere in the app and makes the server
 * refuse writes to it, and keeps every row it holds, so turning it back on
 * restores it as it was. Anyone else is told only admins can change this, the
 * same as the server allows.
 */

import React, { useState } from 'react';
import SettingsNav from '../../components/workspace/SettingsNav';
import { SettingsAnchor } from '../../components/workspace/SettingsSearch';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import Checkbox from '../../components/ui/checkbox';
import { updateWorkspace } from '../../api/workspaces';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers } from '../../lib/capabilities';
import { FEATURES, isFeatureOn } from '../../lib/features';
import type { WorkspaceFeature, WorkspaceRead } from '../../types/Api';

/** Props for FeaturesSection: the workspace whose areas are shown. */
export interface FeaturesSectionProps {
  workspace: WorkspaceRead;
}

/** A toggle per area, each saved at once and followed by a re-read of the workspace. */
export const FeaturesSection: React.FC<FeaturesSectionProps> = ({
  workspace,
}) => {
  const { refresh } = useWorkspace();
  const [pending, setPending] = useState<{
    feature: WorkspaceFeature;
    on: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (
    feature: WorkspaceFeature,
    on: boolean
  ): Promise<void> => {
    setPending({ feature, on });
    setError(null);
    try {
      await updateWorkspace(workspace.id, { features: { [feature]: on } });
      await refresh();
    } catch {
      setError('Could not save this setting. Try again.');
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Features</h3>
        <p className="text-sm text-text-muted">
          Turn off the areas this workspace does not use. They disappear from
          navigation, menus and pickers for everyone, and nothing in them is
          deleted.
        </p>
      </div>
      <ul className="divide-y divide-line rounded-md border border-line">
        {FEATURES.map(({ feature, label, description }) => (
          <li key={feature} className="space-y-1 p-3">
            <Checkbox
              label={label}
              checked={
                pending?.feature === feature
                  ? pending.on
                  : isFeatureOn(workspace, feature)
              }
              disabled={pending !== null}
              onChange={(event) => {
                void save(feature, event.target.checked);
              }}
            />
            <p className="pl-5.5 text-xs text-text-faint">{description}</p>
          </li>
        ))}
      </ul>
      {error !== null && <p className="text-sm text-danger">{error}</p>}
    </section>
  );
};

/** Renders the Features settings for an admin, and a note for anyone else. */
const FeaturesSettings: React.FC = () => {
  const { workspace } = useWorkspace();

  return (
    <WorkspaceShell
      title="Settings"
      toolbar={
        workspace === null ? undefined : <SettingsNav workspace={workspace} />
      }
    >
      {workspace !== null && (
        <div className="max-w-2xl space-y-8">
          {canManageMembers(workspace.role) ? (
            <SettingsAnchor id="features">
              <FeaturesSection workspace={workspace} />
            </SettingsAnchor>
          ) : (
            <p className="text-sm text-text-muted">
              Only workspace owners and admins can turn features on and off.
            </p>
          )}
        </div>
      )}
    </WorkspaceShell>
  );
};

export default FeaturesSettings;
