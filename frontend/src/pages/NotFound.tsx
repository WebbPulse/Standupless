/**
 * The page for a path this application does not serve.
 */

import React from 'react';
import { Link } from 'react-router-dom';

/** Says the page does not exist and points back at the workspaces list. */
const NotFound: React.FC = () => (
  <main className="mx-auto max-w-2xl space-y-4 px-4 py-12">
    <h1 className="text-2xl font-semibold text-white">Page not found</h1>
    <p className="text-sm text-slate-400">
      That page does not exist.{' '}
      <Link to="/workspaces" className="text-sky-400 hover:text-sky-300">
        Go to your workspaces
      </Link>
      .
    </p>
  </main>
);

export default NotFound;
