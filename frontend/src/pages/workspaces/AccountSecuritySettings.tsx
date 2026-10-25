/**
 * The personal Security and access page, Linear's Settings > Account >
 * Security & access: the sign-in email, live sessions, passkeys, two-factor
 * authentication, connected sign-in providers, personal API keys and deleting
 * the account. All of it belongs to the person, so any member reaches it.
 */

import React from 'react';
import EmailSection from '../../components/account/EmailSection';
import SessionsSection from '../../components/account/SessionsSection';
import ApiKeysSection from '../../components/access/ApiKeysSection';
import AccountDeletionPanel from '../../components/auth/AccountDeletionPanel';
import ConnectedAccountsPanel from '../../components/auth/ConnectedAccountsPanel';
import PasskeyPanel from '../../components/auth/PasskeyPanel';
import TwoFactorPanel from '../../components/auth/TwoFactorPanel';
import { SettingsAnchor } from '../../components/workspace/SettingsSearch';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';

/** Renders every way the caller signs in and the controls to end each one. */
const AccountSecuritySettings: React.FC = () => {
  const { workspace } = useWorkspace();

  return (
    <WorkspaceShell title="Settings">
      {workspace !== null && (
        <div className="max-w-2xl space-y-8">
          <SettingsAnchor id="email">
            <EmailSection />
          </SettingsAnchor>
          <SettingsAnchor id="sessions">
            <SessionsSection
              connectedAppsHref={`/w/${workspace.slug}/settings/connected-apps`}
            />
          </SettingsAnchor>
          <SettingsAnchor id="passkeys">
            <PasskeyPanel />
          </SettingsAnchor>
          <SettingsAnchor id="two-factor">
            <TwoFactorPanel />
          </SettingsAnchor>
          <SettingsAnchor id="connected-accounts">
            <ConnectedAccountsPanel />
          </SettingsAnchor>
          <SettingsAnchor id="api-keys">
            <ApiKeysSection workspace={workspace} />
          </SettingsAnchor>
          <AccountDeletionPanel />
        </div>
      )}
    </WorkspaceShell>
  );
};

export default AccountSecuritySettings;
