/**
 * The account security page: passkeys, connected sign-in providers, and
 * deleting the account.
 */

import React from 'react';
import AccountDeletionPanel from '../../components/auth/AccountDeletionPanel';
import ConnectedAccountsPanel from '../../components/auth/ConnectedAccountsPanel';
import PasskeyPanel from '../../components/auth/PasskeyPanel';
import AccountShell from '../../components/layout/AccountShell';
import TextLink from '../../components/ui/link';
import Toaster from '../../components/ui/toast';

/** Account security settings for the signed in user. */
const Security: React.FC = () => (
  <AccountShell>
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Security</h1>
        <p className="text-sm text-text-muted">
          How you sign in to this account.
        </p>
      </div>
      <PasskeyPanel />
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
