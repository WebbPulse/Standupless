/**
 * The account page outside any workspace: the profile and avatar, the
 * interface preferences, the sign-in email, live sessions, passkeys, two-factor authentication, connected sign-in
 * providers, and deleting the account. The same sections sit under each
 * workspace's settings, so a person with no workspace yet can still reach them.
 */

import React from 'react';
import EmailSection from '../../components/account/EmailSection';
import PreferencesSection from '../../components/account/PreferencesSection';
import ProfileSection from '../../components/account/ProfileSection';
import SessionsSection from '../../components/account/SessionsSection';
import AccountDeletionPanel from '../../components/auth/AccountDeletionPanel';
import AvatarPanel from '../../components/auth/AvatarPanel';
import ConnectedAccountsPanel from '../../components/auth/ConnectedAccountsPanel';
import PasskeyPanel from '../../components/auth/PasskeyPanel';
import TwoFactorPanel from '../../components/auth/TwoFactorPanel';
import AccountShell from '../../components/layout/AccountShell';
import TextLink from '../../components/ui/link';
import Toaster from '../../components/ui/toast';

/** Account security settings for the signed in user. */
const Security: React.FC = () => (
  <AccountShell>
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Account</h1>
        <p className="text-sm text-text-muted">
          Your profile and how you sign in to this account.
        </p>
      </div>
      <ProfileSection />
      <AvatarPanel />
      <PreferencesSection />
      <EmailSection />
      <SessionsSection />
      <PasskeyPanel />
      <TwoFactorPanel />
      <ConnectedAccountsPanel />
      <AccountDeletionPanel />
      <p className="text-sm text-text-muted">
        <TextLink to="/workspaces">Back to your workspaces</TextLink>
      </p>
    </div>
    <Toaster />
  </AccountShell>
);

export default Security;
