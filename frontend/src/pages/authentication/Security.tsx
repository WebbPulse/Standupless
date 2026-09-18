/**
 * The account security page, which today holds passkey management.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import PasskeyPanel from '../../components/auth/PasskeyPanel';

/** Account security settings for the signed in user. */
const Security: React.FC = () => (
  <main className="mx-auto max-w-2xl space-y-6 px-4 py-12">
    <h1 className="text-2xl font-semibold text-white">Security</h1>
    <PasskeyPanel />
    <p className="text-sm text-slate-400">
      <Link to="/workspaces" className="text-sky-400 hover:text-sky-300">
        Back to your workspaces
      </Link>
    </p>
  </main>
);

export default Security;
