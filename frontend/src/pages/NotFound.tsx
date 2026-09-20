/**
 * The page for a path this application does not serve.
 */

import React from 'react';
import TextLink from '../components/ui/link';

/** Says the page does not exist and points back at the workspaces list. */
const NotFound: React.FC = () => (
  <main className="flex min-h-screen flex-col items-center px-4 pt-[20vh] pb-12 text-center">
    <div className="max-w-sm space-y-2">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-text-muted">
        That page does not exist.{' '}
        <TextLink to="/workspaces">Go to your workspaces</TextLink>.
      </p>
    </div>
  </main>
);

export default NotFound;
