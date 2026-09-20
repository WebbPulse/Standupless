/**
 * The account security page, which today holds passkey management.
 */

import React from 'react';
import PasskeyPanel from '../../components/auth/PasskeyPanel';
import AccountShell from '../../components/layout/AccountShell';
import TextLink from '../../components/ui/link';

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
      <p className="text-sm text-text-muted">
        <TextLink to="/workspaces">Back to your workspaces</TextLink>
      </p>
    </div>
  </AccountShell>
);

export default Security;
