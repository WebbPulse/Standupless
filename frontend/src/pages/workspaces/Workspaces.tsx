/**
 * The workspace picker, where signing in lands. Someone with exactly one
 * workspace is forwarded straight into it and someone with none is sent to
 * create their first, so the list only shows when there is a choice to make,
 * or when a page asked for it on purpose with `?all`. Workspaces that approve
 * the caller's verified email domain are offered below, and count as a choice.
 * When the home page sends a signed in visitor here, the workspace they last
 * opened in this browser is resumed ahead of the choice, as long as it is
 * still one of theirs.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { LuChevronRight, LuPlus } from 'react-icons/lu';
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';
import {
  joinWorkspace,
  listJoinableWorkspaces,
  listWorkspaces,
} from '../../api/workspaces';
import AccountShell from '../../components/layout/AccountShell';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import { Badge, Kbd } from '../../components/ui/badge';
import Button from '../../components/ui/button';
import Spinner from '../../components/ui/spinner';
import { useAuth } from '../../hooks/useAuth';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { readLastWorkspace, wantsResume } from '../../lib/lastWorkspace';
import { NEW_WORKSPACE_PATH, workspacePath } from '../../lib/paths';
import { JOINABLE_WORKSPACES_KEY, WORKSPACES_KEY } from '../../lib/queryKeys';
import type { JoinableWorkspaceRead, WorkspaceRead } from '../../types/Api';

/** How often the workspace list is re-read while this page is open. */
const POLL_MS = 60000;

/** How a workspace role reads beside its name. */
const roleLabel = (role: WorkspaceRead['role']): string | null => {
  if (role === undefined) return null;
  return role.charAt(0).toUpperCase() + role.slice(1);
};

/** Chooses a workspace, forwarding past the choice when there is none. */
const Workspaces: React.FC = () => {
  const auth = useQueryAuth();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const location = useLocation();
  const browsing = params.has('all');
  const resuming = !browsing && wantsResume(location.state);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listWorkspaces(signal),
    {
      intervalMs: POLL_MS,
      queryKey: WORKSPACES_KEY,
      auth,
    }
  );

  const {
    data: joinableData,
    error: joinableError,
    isLoading: joinableLoading,
  } = usePolledQuery(({ signal }) => listJoinableWorkspaces(signal), {
    intervalMs: POLL_MS,
    queryKey: JOINABLE_WORKSPACES_KEY,
    auth,
  });

  const {
    mutate: join,
    error: joinError,
    isMutating: joining,
  } = useMutationWithRefetch(
    (workspace: JoinableWorkspaceRead) => joinWorkspace(workspace.id),
    [WORKSPACES_KEY, JOINABLE_WORKSPACES_KEY]
  );

  const workspaces = data ?? [];
  const joinable = joinableData ?? [];
  const joinableSettled =
    !joinableLoading && (joinableData !== null || joinableError !== null);
  const settled =
    !isLoading && data !== null && error === null && joinableSettled;
  const rowCount = workspaces.length + 1;

  const { activeIndex, setActiveIndex, registerItem } = useListKeyboardNav({
    count: settled ? rowCount : 0,
    resetKey: workspaces.map((workspace) => workspace.id).join(','),
    onActivate: (index) => {
      const chosen = workspaces[index];
      void navigate(
        chosen === undefined ? NEW_WORKSPACE_PATH : workspacePath(chosen.slug)
      );
    },
  });

  const joinAndOpen = async (
    workspace: JoinableWorkspaceRead
  ): Promise<void> => {
    if (joining) return;
    try {
      await join(workspace);
      void navigate(workspacePath(workspace.slug));
    } catch {
      return;
    }
  };

  if (settled && workspaces.length === 0 && joinable.length === 0) {
    return <Navigate to={NEW_WORKSPACE_PATH} replace />;
  }

  const last = resuming ? readLastWorkspace() : null;
  const resumed =
    last === null
      ? undefined
      : workspaces.find((workspace) => workspace.slug === last);
  if (settled && resumed !== undefined) {
    return <Navigate to={workspacePath(resumed.slug)} replace />;
  }

  const only = workspaces.length === 1 ? workspaces[0] : undefined;
  if (settled && !browsing && only !== undefined && joinable.length === 0) {
    return <Navigate to={workspacePath(only.slug)} replace />;
  }

  const host = typeof window === 'undefined' ? '' : window.location.host;
  const rowClass = (index: number): string =>
    cn(
      'flex h-14 items-center gap-3 px-4 text-sm transition-colors duration-100 hover:bg-raised focus-visible:bg-raised focus-visible:outline-none',
      activeIndex === index && 'bg-raised'
    );

  return (
    <AccountShell>
      <div className="mx-auto flex max-w-md flex-col gap-6 pt-6 sm:pt-12">
        <header className="space-y-1 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            Choose a workspace
          </h1>
          {user !== null && (
            <p className="text-sm text-text-muted">Signed in as {user.email}</p>
          )}
        </header>

        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load your workspaces.')}
          />
        )}

        {isLoading || (data === null && error === null) || !joinableSettled ? (
          <Spinner label="Loading workspaces" />
        ) : (
          <div className="overflow-hidden rounded-md border border-line bg-surface shadow-sm">
            <ul aria-label="Your workspaces" className="divide-y divide-line">
              {workspaces.map((workspace, index) => {
                const role = roleLabel(workspace.role);
                return (
                  <li key={workspace.id}>
                    <Link
                      ref={registerItem(index)}
                      to={workspacePath(workspace.slug)}
                      aria-current={activeIndex === index ? 'true' : undefined}
                      onPointerEnter={() => {
                        setActiveIndex(index);
                      }}
                      className={rowClass(index)}
                    >
                      <Avatar
                        name={workspace.name}
                        src={workspace.icon_url}
                        size="md"
                        shape="square"
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium text-text">
                          {workspace.name}
                        </span>
                        <span className="truncate text-xs text-text-faint">
                          {host}
                          {workspacePath(workspace.slug)}
                        </span>
                      </span>
                      {role !== null && (
                        <Badge className="hidden sm:inline-flex">{role}</Badge>
                      )}
                      <LuChevronRight
                        className="h-4 w-4 shrink-0 text-text-faint"
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
            <Link
              ref={registerItem(workspaces.length)}
              to={NEW_WORKSPACE_PATH}
              aria-current={
                activeIndex === workspaces.length ? 'true' : undefined
              }
              onPointerEnter={() => {
                setActiveIndex(workspaces.length);
              }}
              className={cn(
                rowClass(workspaces.length),
                'h-12 text-text-muted hover:text-text',
                workspaces.length > 0 && 'border-t border-line'
              )}
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-sm border border-dashed border-line-strong">
                <LuPlus className="h-4 w-4" aria-hidden="true" />
              </span>
              Create a workspace
            </Link>
          </div>
        )}

        {joinError !== null && (
          <ErrorAlert
            message={errorMessage(joinError, 'Could not join the workspace.')}
          />
        )}

        {settled && joinable.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-medium text-text-muted">
              Workspaces you can join
            </h2>
            <ul
              aria-label="Workspaces you can join"
              className="divide-y divide-line overflow-hidden rounded-md border border-line bg-surface shadow-sm"
            >
              {joinable.map((workspace) => (
                <li
                  key={workspace.id}
                  className="flex h-14 items-center gap-3 px-4 text-sm"
                >
                  <Avatar
                    name={workspace.name}
                    src={workspace.icon_url}
                    size="md"
                    shape="square"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium text-text">
                      {workspace.name}
                    </span>
                    <span className="truncate text-xs text-text-faint">
                      Open to verified {workspace.domain} emails
                    </span>
                  </span>
                  <Button
                    size="sm"
                    aria-label={`Join ${workspace.name}`}
                    disabled={joining}
                    onClick={() => {
                      void joinAndOpen(workspace);
                    }}
                  >
                    Join
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {settled && (
          <p className="hidden items-center justify-center gap-1.5 text-xs text-text-faint sm:flex">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            to move,
            <Kbd>Enter</Kbd>
            to open
          </p>
        )}
      </div>
    </AccountShell>
  );
};

export default Workspaces;
