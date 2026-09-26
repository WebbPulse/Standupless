/**
 * The page for a path this application does not serve, in the public shell so
 * it reads the same whether or not the visitor is signed in.
 */

import React from 'react';
import PublicShell from '../components/layout/PublicShell';
import TextLink from '../components/ui/link';

/** Says the page does not exist and points back at the workspaces list. */
const NotFound: React.FC = () => (
  <PublicShell className="flex justify-center px-4 pt-[18vh] pb-24">
    <div className="w-full max-w-sm space-y-3">
      <h1 className="text-[28px] leading-[1.15] font-semibold tracking-[-0.03em]">
        Page not found
      </h1>
      <p className="text-sm text-text-muted">
        That page does not exist.{' '}
        <TextLink to="/workspaces">Go to your workspaces</TextLink>.
      </p>
    </div>
  </PublicShell>
);

export default NotFound;
