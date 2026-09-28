/**
 * The signed out page a person lands on once their account is deleted. It is
 * public, so it renders after the session has ended, and it only confirms what
 * happened: there is nothing left to undo.
 */

import React from 'react';
import PublicShell from '../../components/layout/PublicShell';
import TextLink from '../../components/ui/link';
import { PRIVACY_PATH } from '../../lib/paths';

/** Confirms the deletion and says what happens to the data. */
const AccountDeleted: React.FC = () => (
  <PublicShell className="flex justify-center px-4 pt-[18vh] pb-24">
    <div className="w-full max-w-sm space-y-3" role="status">
      <h1 className="text-[28px] leading-[1.15] font-semibold tracking-[-0.03em]">
        Your account was deleted
      </h1>
      <p className="text-sm text-text-muted">
        You are signed out on every device, and your API keys and connected apps
        no longer work. Your personal data is being removed now. Issues and
        comments you wrote stay in their workspaces and show as written by a
        deleted user.
      </p>
      <p className="text-sm text-text-muted">
        We sent a confirmation to your email address. The{' '}
        <TextLink to={PRIVACY_PATH}>privacy policy</TextLink> says what is kept
        and for how long. <TextLink to="/">Back to the home page</TextLink>.
      </p>
    </div>
  </PublicShell>
);

export default AccountDeleted;
