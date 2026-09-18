/**
 * The frame every page under `/w/:slug` renders inside: the workspace name, the
 * navigation between its sections, and the resolving and not-found states the
 * slug lookup can land in.
 */

import React from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import InboxBadge from '../views/InboxBadge';
import { ErrorAlert } from '../ui/alert';
import Spinner from '../ui/spinner';

/** Props for WorkspaceShell: the page body to frame. */
export interface WorkspaceShellProps {
  children: ReactNode;
}

const linkClass = ({ isActive }: { isActive: boolean }): string =>
  isActive
    ? 'border-b-2 border-sky-400 pb-1 text-sm text-white'
    : 'border-b-2 border-transparent pb-1 text-sm text-slate-400 hover:text-slate-200';

/**
 * Renders the workspace chrome, or the spinner, error and not-found states in
 * its place while the slug is being resolved.
 */
export const WorkspaceShell: React.FC<WorkspaceShellProps> = ({ children }) => {
  const { workspace, isLoading, notFound, error } = useWorkspace();

  if (isLoading) {
    return <Spinner label="Loading workspace" />;
  }

  if (error !== null && workspace === null) {
    return (
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-12">
        <ErrorAlert
          message={errorMessage(error, 'Could not load this workspace.')}
        />
        <p className="text-sm text-slate-400">
          <Link to="/workspaces" className="text-sky-400 hover:text-sky-300">
            Back to your workspaces
          </Link>
        </p>
      </main>
    );
  }

  if (notFound || workspace === null) {
    return (
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-12">
        <h1 className="text-2xl font-semibold text-white">
          Workspace not found
        </h1>
        <p className="text-sm text-slate-400">
          That workspace does not exist, or you are not a member of it.{' '}
          <Link to="/workspaces" className="text-sky-400 hover:text-sky-300">
            Back to your workspaces
          </Link>
          .
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-12">
      <header className="space-y-4">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-semibold text-white">
            {workspace.name}
          </h1>
          <Link
            to="/workspaces"
            className="text-sm text-sky-400 hover:text-sky-300"
          >
            All workspaces
          </Link>
        </div>
        <nav className="flex gap-6">
          <NavLink to={`/w/${workspace.slug}`} end className={linkClass}>
            Projects
          </NavLink>
          <NavLink to={`/w/${workspace.slug}/issues`} end className={linkClass}>
            My issues
          </NavLink>
          <NavLink to={`/w/${workspace.slug}/search`} end className={linkClass}>
            Search
          </NavLink>
          <NavLink
            to={`/w/${workspace.slug}/inbox`}
            end
            className={linkClass}
          >
            Inbox
            <InboxBadge workspaceId={workspace.id} />
          </NavLink>
          {canManageMembers(workspace.role) && (
            <NavLink to={`/w/${workspace.slug}/settings`} className={linkClass}>
              Settings
            </NavLink>
          )}
        </nav>
      </header>
      {children}
    </main>
  );
};

export default WorkspaceShell;
