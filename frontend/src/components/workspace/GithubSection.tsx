/**
 * The GitHub integration card of one workspace: connecting the App, seeing the
 * account and repositories it covers, pointing each repository at a team, and
 * disconnecting.
 *
 * Connecting sends the admin to GitHub's own install page, where they pick the
 * organization and repositories, and GitHub sends them back here with an outcome
 * that `GithubReturnToast` reads. The install URL carries a signed state that
 * expires, so it is fetched when the button is pressed rather than held from the
 * page load. Disconnecting only forgets the installation on this side, because
 * removing the App itself is a GitHub setting this cannot reach on the
 * workspace's behalf, so the link to do that is offered alongside.
 *
 * The installation read stops once it settles. A 404 and a 503 NOT_CONFIGURED
 * are answers rather than failures, and re-asking cannot change either until
 * someone installs the App or configures the environment. Polling resumes when
 * the connect button is pressed, when GitHub sends the admin back, or when the
 * window regains focus. A transient failure still retries, backing off to two
 * minutes. The decision to stop is taken when a read answers rather than while
 * rendering, so a focus refetch that finds a new installation keeps polling
 * instead of being settled by the stale answer it is replacing.
 *
 * The repositories and teams reads hang off the installation, so a workspace
 * with none asks for neither.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  LuExternalLink,
  LuGithub,
  LuGlobe,
  LuLock,
  LuTriangleAlert,
} from 'react-icons/lu';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
  type PolledQueryContext,
} from '@webbpulse/api-client/react';
import {
  deleteInstallation,
  getInstallUrl,
  linkRepository,
  listRepositories,
  readInstallation,
  type InstallationState,
} from '../../api/integrations';
import { listTeams } from '../../api/teams';
import { errorMessage } from '../../lib/errors';
import {
  installationKey,
  teamsKey,
  repositoriesKey,
} from '../../lib/queryKeys';
import type {
  GithubInstallationRead,
  GithubRepositoryRead,
  TeamRead,
  WorkspaceRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Badge from '../ui/badge';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import { SelectField } from '../ui/select';
import { Skeleton } from '../ui/skeleton';
import GithubReturnToast from './GithubReturnToast';

/** Props for GithubSection: the workspace whose installation is shown. */
export interface GithubSectionProps {
  workspace: WorkspaceRead;
}

/** How often the installation and its repositories are re-read. */
const POLL_MS = 30000;

/**
 * Ceiling on the backoff a transient failure grows to, two minutes.
 *
 * The hook's own default is five, which is longer than a person watching this
 * panel will wait after a blip.
 */
const MAX_BACKOFF_MS = 120000;

/** The column layout the repository header and every row share. */
const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4';

/** The classes an outbound GitHub link takes, matching a small secondary button. */
const LINK_BUTTON =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-line-strong bg-bg px-2 text-xs font-medium whitespace-nowrap text-text transition-colors duration-100 hover:bg-raised';

/** Where GitHub keeps this installation's settings, preferring what the API reported. */
const manageHref = (installation: GithubInstallationRead): string =>
  installation.manage_url !== ''
    ? installation.manage_url
    : installation.html_url;

/** "1 repository" or "3 repositories". */
const repositoryCount = (count: number): string =>
  `${String(count)} ${count === 1 ? 'repository' : 'repositories'}`;

/** Shows the integration card, its state, and the connect and disconnect actions. */
export const GithubSection: React.FC<GithubSectionProps> = ({ workspace }) => {
  const auth = useQueryAuth();
  const installKey = installationKey(workspace.id);
  const reposKey = repositoriesKey(workspace.id);
  const [installError, setInstallError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const [polling, setPolling] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const readAndSettle = useCallback(
    async ({ signal }: PolledQueryContext): Promise<InstallationState> => {
      const result = await readInstallation(workspace.id, signal);
      if (!signal.aborted) setPolling(result.status === 'installed');
      return result;
    },
    [workspace.id]
  );

  const {
    data: state,
    error,
    isLoading,
    refetch,
  } = usePolledQuery(readAndSettle, {
    intervalMs: POLL_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
    enabled: polling,
    queryKey: installKey,
    auth,
  });

  const installation =
    state !== null && state.status === 'installed' ? state.installation : null;
  const notConfigured = state !== null && state.status === 'not_configured';

  const {
    data: repositories,
    error: reposError,
    isLoading: reposLoading,
  } = usePolledQuery(({ signal }) => listRepositories(workspace.id, signal), {
    intervalMs: POLL_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
    enabled: installation !== null,
    queryKey: reposKey,
    auth,
  });

  const { data: teams } = usePolledQuery(
    ({ signal }) => listTeams(workspace.id, signal),
    {
      intervalMs: POLL_MS,
      maxBackoffMs: MAX_BACKOFF_MS,
      enabled: installation !== null,
      queryKey: teamsKey(workspace.id),
      auth,
    }
  );

  const { mutate: disconnect, error: disconnectError } = useMutationWithRefetch(
    () => deleteInstallation(workspace.id),
    installKey
  );

  const { mutate: pin, error: pinError } = useMutationWithRefetch(
    (input: { repositoryId: string; teamId: string | null }) =>
      linkRepository(workspace.id, input.repositoryId, input.teamId),
    reposKey
  );

  const resume = useCallback((): void => {
    setPolling(true);
    void refetch().catch(() => undefined);
  }, [refetch]);

  const onConnect = (): void => {
    resume();
    setStarting(true);
    setInstallError(null);
    void getInstallUrl(workspace.id)
      .then((result) => {
        globalThis.location.assign(result.url);
      })
      .catch((reason: unknown) => {
        setInstallError(reason);
        setStarting(false);
      });
  };

  const onDisconnect = (): void => {
    setDisconnecting(true);
    void disconnect()
      .then(() => {
        setConfirming(false);
      })
      .catch(() => undefined)
      .finally(() => {
        setDisconnecting(false);
      });
  };

  const closeConfirm = useCallback((): void => {
    setConfirming(false);
  }, []);

  useEffect(() => {
    if (polling) return undefined;
    const onFocus = (): void => {
      resume();
    };
    globalThis.addEventListener('focus', onFocus);
    return () => {
      globalThis.removeEventListener('focus', onFocus);
    };
  }, [polling, resume]);

  const status = isLoading ? null : notConfigured ? (
    <Badge>Unavailable</Badge>
  ) : installation === null ? null : installation.suspended ? (
    <Badge tone="warning">Suspended</Badge>
  ) : (
    <Badge tone="success">Connected</Badge>
  );

  const showConnect = !isLoading && error === null && installation === null;

  return (
    <section aria-labelledby="github-integration-title" className="space-y-3">
      <GithubReturnToast onOutcome={resume} />

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex flex-wrap items-start gap-3 p-4">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line bg-bg"
          >
            <LuGithub className="h-5 w-5 text-text" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2
                id="github-integration-title"
                className="text-sm font-semibold"
              >
                GitHub
              </h2>
              {status}
            </div>
            <p className="mt-0.5 text-sm text-text-muted">
              Link branches and pull requests to issues by their key, and move
              issues as pull requests open and merge.
            </p>
          </div>
          {showConnect && (
            <Button
              variant="primary"
              onClick={onConnect}
              disabled={starting || notConfigured}
            >
              <LuGithub aria-hidden="true" className="h-4 w-4" />
              {starting ? 'Opening GitHub' : 'Connect GitHub'}
            </Button>
          )}
        </div>

        {isLoading ? (
          <div
            role="status"
            aria-label="Loading the GitHub connection"
            className="space-y-2 border-t border-line px-4 py-4"
          >
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ) : error !== null ? (
          <div className="space-y-3 border-t border-line p-4">
            <ErrorAlert
              message={errorMessage(
                error,
                'Could not load the GitHub connection.'
              )}
            />
            <Button size="sm" onClick={resume}>
              Try again
            </Button>
          </div>
        ) : notConfigured ? (
          <p className="border-t border-line px-4 py-3 text-sm text-text-muted">
            The GitHub App is not set up in this environment yet, so there is
            nothing to connect to. Connecting opens here once it is.
          </p>
        ) : installation === null ? (
          <div className="space-y-1 border-t border-line px-4 py-3">
            <p className="text-sm text-text-muted">
              This workspace is not connected to GitHub.
            </p>
            <p className="text-xs text-text-faint">
              You choose the organization and repositories on GitHub.
              Standupless reads branches and pull requests, and writes one
              comment and one check on each linked pull request.
            </p>
          </div>
        ) : (
          <ConnectedBody
            installation={installation}
            repositories={repositories ?? null}
            reposLoading={reposLoading}
            teams={teams ?? []}
            onDisconnect={() => {
              setConfirming(true);
            }}
            onPin={(repositoryId, teamId) => {
              void pin({ repositoryId, teamId }).catch(() => undefined);
            }}
          />
        )}
      </div>

      {installError !== null && (
        <ErrorAlert
          message={errorMessage(installError, 'Could not open GitHub.')}
        />
      )}
      {pinError !== null && (
        <ErrorAlert
          message={errorMessage(pinError, 'Could not change that repository.')}
        />
      )}
      {reposError !== null && (
        <ErrorAlert
          message={errorMessage(reposError, 'Could not load the repositories.')}
        />
      )}

      <Dialog
        open={confirming}
        onClose={closeConfirm}
        title="Disconnect GitHub?"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            Standupless stops reading branches and pull requests from{' '}
            <span className="font-medium text-text">
              {installation?.account_login ?? 'GitHub'}
            </span>
            . Links already on issues stay. The App stays installed on GitHub
            until you remove it there.
          </p>
          {disconnectError !== null && (
            <ErrorAlert
              message={errorMessage(
                disconnectError,
                'Could not disconnect GitHub.'
              )}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={closeConfirm}>Cancel</Button>
            <Button
              variant="danger"
              onClick={onDisconnect}
              disabled={disconnecting}
            >
              {disconnecting ? 'Disconnecting' : 'Disconnect'}
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
};

/** Props for ConnectedBody: the installation, its repositories and the row actions. */
interface ConnectedBodyProps {
  installation: GithubInstallationRead;
  repositories: GithubRepositoryRead[] | null;
  reposLoading: boolean;
  teams: TeamRead[];
  onDisconnect: () => void;
  onPin: (repositoryId: string, teamId: string | null) => void;
}

/** The account row and the repository list of a connected workspace. */
const ConnectedBody: React.FC<ConnectedBodyProps> = ({
  installation,
  repositories,
  reposLoading,
  teams,
  onDisconnect,
  onPin,
}) => {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const rows = repositories ?? [];
  const accountKind =
    installation.account_type === 'Organization'
      ? 'Organization'
      : 'Personal account';
  const coverage =
    installation.repository_selection === 'all'
      ? `All repositories, ${repositoryCount(rows.length)}`
      : `${repositoryCount(rows.length)} selected`;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
        {installation.avatar_url !== '' && !avatarFailed ? (
          <img
            src={installation.avatar_url}
            alt=""
            className="h-8 w-8 shrink-0 rounded-md border border-line"
            onError={() => {
              setAvatarFailed(true);
            }}
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-raised"
          >
            <LuGithub className="h-4 w-4 text-text-muted" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            Connected to {installation.account_login}
          </p>
          <p className="text-xs text-text-muted">
            {accountKind}, {coverage}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <a
            className={LINK_BUTTON}
            href={manageHref(installation)}
            target="_blank"
            rel="noreferrer"
          >
            Manage on GitHub
            <LuExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
          </a>
          <Button size="sm" onClick={onDisconnect}>
            Disconnect
          </Button>
        </div>
      </div>

      {installation.suspended && (
        <div className="flex items-start gap-2 border-t border-line bg-warning-soft px-4 py-2.5 text-xs text-warning">
          <LuTriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5" />
          <p>
            The App is suspended on {installation.account_login}, so GitHub
            sends no events until an owner unsuspends it there.
          </p>
        </div>
      )}

      <div className="border-t border-line">
        <div
          className={`${COLUMNS} h-8 border-b border-line bg-bg text-xs font-medium text-text-muted`}
        >
          <span className="flex items-center gap-2">
            Repositories
            <Badge>{String(rows.length)}</Badge>
          </span>
          <span>Team</span>
        </div>
        {reposLoading && repositories === null ? (
          <div
            role="status"
            aria-label="Loading the repositories"
            className="space-y-2 px-4 py-3"
          >
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        ) : rows.length === 0 ? (
          <p className="px-4 py-3 text-sm text-text-muted">
            No repositories yet. Choose some with Manage on GitHub.
          </p>
        ) : (
          <ul>
            {rows.map((repo) => (
              <li
                key={repo.repository_id}
                className={`${COLUMNS} h-row border-b border-line transition-colors duration-100 last:border-b-0 hover:bg-raised`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  {repo.private ? (
                    <LuLock
                      aria-label="Private"
                      className="h-3.5 w-3.5 shrink-0 text-text-faint"
                    />
                  ) : (
                    <LuGlobe
                      aria-label="Public"
                      className="h-3.5 w-3.5 shrink-0 text-text-faint"
                    />
                  )}
                  <span className="truncate font-mono text-xs font-medium text-text">
                    {repo.full_name}
                  </span>
                </div>
                <SelectField
                  id={`repo-team-${repo.repository_id}`}
                  label="Team"
                  hideLabel
                  className="w-40"
                  value={repo.team_id ?? ''}
                  onChange={(event) => {
                    onPin(
                      repo.repository_id,
                      event.target.value === '' ? null : event.target.value
                    );
                  }}
                >
                  <option value="">Every team</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </SelectField>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
};

export default GithubSection;
