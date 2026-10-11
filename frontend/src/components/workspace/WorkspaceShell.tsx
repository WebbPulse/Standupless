/**
 * The frame every page under `/w/:slug` renders inside: the sidebar on the
 * darker app background, one inset panel beside it holding the page bar, the
 * page and the peek pane, and the resolving, error and not-found states the
 * slug lookup can land in. On a phone the sidebar becomes a drawer opened from
 * the page bar and the panel runs edge to edge.
 *
 * The command palette, the shortcut layer and the dialogs that outlive a page
 * live one level up in {@link WorkspaceLayout}. The shell renders the peek
 * pane's frame beside the page, because the pane shares the page's row.
 *
 * The frame is positioned and clips, and so is the sidebar's column, so an
 * absolutely positioned element anywhere inside, such as a visually hidden
 * live region below the fold of the sidebar, can never stretch the app shell
 * into a second scroller. Only the sidebar nav and the page body scroll.
 */

import React, { useEffect, useRef, useState } from 'react';
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
import { PeekPane } from './PeekPane';
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

/**
 * The body of the page column, padded unless the page asks for the edges. It
 * is positioned so absolutely positioned content inside it, such as a visually
 * hidden label, scrolls with the page instead of overflowing the shell.
 */
const Body: React.FC<{ flush: boolean; children: ReactNode }> = ({
  flush,
  children,
}) => (
  <div
    className={cn(
      'relative min-h-0 flex-1',
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
  const drawer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    drawer.current?.querySelector<HTMLElement>('nav a[href]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpenedAt(null);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [drawerOpen]);

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
    <div
      className="relative flex min-h-0 flex-1 overflow-clip bg-app"
      data-testid="signed-in"
    >
      <aside
        data-testid="sidebar-frame"
        className="relative hidden min-h-0 w-sidebar shrink-0 overflow-hidden lg:block"
      >
        <Sidebar workspace={workspace} />
      </aside>

      {drawerOpen && (
        <div
          ref={drawer}
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
          className="fixed inset-0 z-50 flex lg:hidden"
        >
          <div
            className="absolute inset-0 animate-[backdrop-in_160ms_ease-out] bg-black/40 dark:bg-black/60"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div className="relative flex h-full w-[min(18rem,calc(100vw-4rem))] animate-[drawer-in_180ms_ease-out] flex-col border-r border-line pb-[env(safe-area-inset-bottom)] shadow-overlay">
            <Sidebar
              workspace={workspace}
              onNavigate={() => setDrawerOpen(false)}
            />
            <div className="absolute top-2 left-full ml-2">
              <IconButton
                label="Close navigation"
                variant="secondary"
                onClick={() => setDrawerOpen(false)}
              >
                <LuX className="h-4 w-4" />
              </IconButton>
            </div>
          </div>
        </div>
      )}

      <div
        data-testid="content-panel"
        className="flex min-w-0 flex-1 overflow-hidden bg-bg lg:my-2 lg:mr-2 lg:rounded-lg lg:border lg:border-line lg:shadow-xs"
      >
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

        <PeekPane />
      </div>
    </div>
  );
};

export default WorkspaceShell;
