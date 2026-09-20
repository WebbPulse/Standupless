/**
 * The frame every page under `/w/:slug` renders inside: the sidebar, the page
 * bar with the title and actions, and the resolving, error and not-found
 * states the slug lookup can land in. On a phone the sidebar becomes a drawer
 * opened from the page bar.
 */

import React, { useState } from 'react';
import type { ReactNode } from 'react';
import { LuMenu, LuX } from 'react-icons/lu';
import { useLocation } from 'react-router-dom';
import { useWorkspace } from '../../hooks/useWorkspace';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { ErrorAlert } from '../ui/alert';
import { IconButton } from '../ui/button';
import TextLink from '../ui/link';
import PageHeader from '../ui/page-header';
import Spinner from '../ui/spinner';
import Sidebar from './Sidebar';

/** Props for WorkspaceShell: the page bar contents and the body to frame. */
export interface WorkspaceShellProps {
  children: ReactNode;
  /** The page title. Falls back to the workspace name. */
  title?: ReactNode;
  /** Buttons on the right of the title. */
  actions?: ReactNode;
  /** A second row under the title, for filters and view switches. */
  toolbar?: ReactNode;
  /** Something before the title, such as a breadcrumb. */
  leading?: ReactNode;
  /** Lets the body run edge to edge and manage its own scrolling. */
  flush?: boolean;
}

/** The body of the page column, padded unless the page asks for the edges. */
const Body: React.FC<{ flush: boolean; children: ReactNode }> = ({
  flush,
  children,
}) => (
  <div
    className={cn(
      'min-h-0 flex-1',
      flush
        ? 'flex flex-col overflow-hidden'
        : 'overflow-y-auto px-4 py-4 lg:px-6'
    )}
  >
    {children}
  </div>
);

/**
 * Renders the workspace chrome, or the spinner, error and not-found states in
 * its place while the slug is being resolved.
 */
export const WorkspaceShell: React.FC<WorkspaceShellProps> = ({
  children,
  title,
  actions,
  toolbar,
  leading,
  flush = false,
}) => {
  const { workspace, isLoading, notFound, error } = useWorkspace();
  const location = useLocation();
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const drawerOpen = openedAt === location.pathname;
  const setDrawerOpen = (open: boolean) =>
    setOpenedAt(open ? location.pathname : null);

  if (isLoading) {
    return <Spinner label="Loading workspace" />;
  }

  if (error !== null && workspace === null) {
    return (
      <main className="mx-auto max-w-md space-y-4 px-4 py-16">
        <ErrorAlert
          message={errorMessage(error, 'Could not load this workspace.')}
        />
        <p className="text-sm text-text-muted">
          <TextLink to="/workspaces">Back to your workspaces</TextLink>
        </p>
      </main>
    );
  }

  if (notFound || workspace === null) {
    return (
      <main className="mx-auto max-w-md space-y-2 px-4 py-16">
        <h1 className="text-xl font-semibold">Workspace not found</h1>
        <p className="text-sm text-text-muted">
          That workspace does not exist, or you are not a member of it.{' '}
          <TextLink to="/workspaces">Back to your workspaces</TextLink>.
        </p>
      </main>
    );
  }

  const menuButton = (
    <IconButton
      label="Open navigation"
      size="sm"
      className="lg:hidden"
      onClick={() => setDrawerOpen(true)}
    >
      <LuMenu className="h-4 w-4" />
    </IconButton>
  );

  return (
    <div className="flex h-screen" data-testid="signed-in">
      <aside className="hidden w-sidebar shrink-0 border-r border-line lg:block">
        <Sidebar workspace={workspace} />
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div className="relative flex h-full w-sidebar max-w-[85vw] flex-col border-r border-line shadow-overlay">
            <Sidebar
              workspace={workspace}
              onNavigate={() => setDrawerOpen(false)}
            />
            <IconButton
              label="Close navigation"
              size="sm"
              className="absolute top-2 right-2"
              onClick={() => setDrawerOpen(false)}
            >
              <LuX className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          title={title ?? workspace.name}
          actions={actions}
          toolbar={toolbar}
          leading={
            <>
              {menuButton}
              {leading}
            </>
          }
        />
        <Body flush={flush}>{children}</Body>
      </main>
    </div>
  );
};

export default WorkspaceShell;
