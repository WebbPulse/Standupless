/**
 * The workspace security switch that makes members ask an admin before they
 * connect a third-party app, as Linear's security settings offer it. With it
 * on, a consent to an app the workspace has not approved issues no grant and
 * sends the member to a request page instead. The official MCP server and the
 * CLI are never held. Apps members authorized before the switch was turned on
 * keep working until an admin revokes them from connected apps settings.
 */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { updateWorkspace } from '../../api/workspaces';
import { useWorkspace } from '../../hooks/useWorkspace';
import { connectedAppsPath } from '../../lib/paths';
import type { WorkspaceRead } from '../../types/Api';
import Checkbox from '../ui/checkbox';

/** Props for ThirdPartyAppsSection: the workspace whose setting is shown. */
export interface ThirdPartyAppsSectionProps {
  workspace: WorkspaceRead;
}

/** Turns admin approval of third-party apps on or off, then re-reads the workspace. */
export const ThirdPartyAppsSection: React.FC<ThirdPartyAppsSectionProps> = ({
  workspace,
}) => {
  const { refresh } = useWorkspace();
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (enabled: boolean): Promise<void> => {
    setPending(enabled);
    setError(null);
    try {
      await updateWorkspace(workspace.id, {
        third_party_app_approvals: enabled,
      });
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
        <h3 className="text-base font-semibold">Third-party applications</h3>
        <p className="text-sm text-text-muted">
          Control which OAuth apps members can connect to this workspace.
        </p>
      </div>
      <div className="space-y-2 rounded-md border border-line p-3">
        <Checkbox
          label="Require admin approval for third-party apps"
          checked={pending ?? workspace.third_party_app_approvals === true}
          disabled={pending !== null}
          onChange={(event) => {
            void save(event.target.checked);
          }}
        />
        <p className="pl-5.5 text-xs text-text-faint">
          Members ask for access the first time they authorize an app, and an
          admin approves or denies it. The Standupless MCP server and CLI are
          always allowed. Apps already authorized keep working until you revoke
          them in{' '}
          <Link
            to={connectedAppsPath(workspace.slug)}
            className="text-accent hover:underline"
          >
            connected apps
          </Link>
          .
        </p>
      </div>
      {error !== null && <p className="text-sm text-danger">{error}</p>}
    </section>
  );
};

export default ThirdPartyAppsSection;
