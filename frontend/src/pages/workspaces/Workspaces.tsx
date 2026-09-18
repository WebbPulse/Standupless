/**
 * The authenticated landing page, listing the workspaces the signed in user
 * belongs to. A placeholder until the issue tracker's own screens exist.
 */

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listWorkspaces } from '../../api/workspaces';
import { ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
import Spinner from '../../components/ui/spinner';
import { useAuth } from '../../hooks/useAuth';
import type { WorkspaceRead } from '../../types/Api';

/** Reads the workspace list on mount and renders it, or an empty state. */
const Workspaces: React.FC = () => {
  const [workspaces, setWorkspaces] = useState<WorkspaceRead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { user, logout } = useAuth();

  useEffect(() => {
    const controller = new AbortController();
    listWorkspaces(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setWorkspaces(items);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError('Could not load your workspaces. Try again.');
        setWorkspaces([]);
      });
    return () => {
      controller.abort();
    };
  }, []);

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-12">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-white">Workspaces</h1>
        <Button variant="secondary" onClick={() => void logout()}>
          Sign out
        </Button>
      </header>

      {user !== null && (
        <p className="text-sm text-slate-400">Signed in as {user.email}.</p>
      )}

      <ErrorAlert message={error} />

      {workspaces === null ? (
        <Spinner label="Loading workspaces" />
      ) : workspaces.length === 0 ? (
        <p className="text-sm text-slate-400">
          You are not a member of any workspace yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {workspaces.map((workspace) => (
            <li
              key={workspace.id}
              className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-100"
            >
              {workspace.name}
            </li>
          ))}
        </ul>
      )}

      <p className="text-sm text-slate-400">
        <Link to="/security" className="text-sky-400 hover:text-sky-300">
          Security settings
        </Link>
      </p>
    </main>
  );
};

export default Workspaces;
