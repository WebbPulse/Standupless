/**
 * The GitHub App installation of one workspace: installing it, seeing the
 * repositories it can reach, pointing each at a team, and disconnecting.
 *
 * The install URL carries a signed state that expires, so it is fetched when
 * the button is pressed rather than held from the page load. Disconnecting only
 * forgets the installation on this side, because removing the App itself is a
 * GitHub setting this cannot reach on the workspace's behalf, so the link to do
 * that is offered alongside.
 *
 * The installation read stops once it settles. A 404 and a 503 NOT_CONFIGURED
 * are answers rather than failures, and re-asking cannot change either until
 * someone installs the App or configures the environment, so polling them every
 * 30 seconds was 28 identical calls in a quarter of an hour during one sitting.
 * Polling resumes when the install button is pressed or when the window regains
 * focus, which is what returning from GitHub looks like. A transient failure
 * still retries, backing off to two minutes rather than the hook's five. The
 * decision to stop is taken when a read answers rather than while rendering,
 * so a focus refetch that finds a new installation keeps polling instead of
 * being settled by the stale answer it is replacing.
 *
 * The repositories and teams reads hang off the installation, so a workspace
 * with none asks for neither.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { LuExternalLink } from 'react-icons/lu';
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
import type { WorkspaceRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Badge from '../ui/badge';
import Button from '../ui/button';
import { SelectField } from '../ui/select';
import Spinner from '../ui/spinner';

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
 * panel will wait after a blip, and shorter than the 30 second floor this used
 * to sit at forever.
 */
const MAX_BACKOFF_MS = 120000;

/** The column layout the repository header and every row share. */
const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3';

/** Shows the installation, its repositories, and the install and remove actions. */
export const GithubSection: React.FC<GithubSectionProps> = ({ workspace }) => {
  const auth = useQueryAuth();
  const installKey = installationKey(workspace.id);
  const reposKey = repositoriesKey(workspace.id);
  const [installError, setInstallError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const [polling, setPolling] = useState(true);

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

  const { data: repositories, error: reposError } = usePolledQuery(
    ({ signal }) => listRepositories(workspace.id, signal),
    {
      intervalMs: POLL_MS,
      maxBackoffMs: MAX_BACKOFF_MS,
      enabled: installation !== null,
      queryKey: reposKey,
      auth,
    }
  );

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

  const onInstall = (): void => {
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

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">GitHub</h2>
        <p className="text-sm text-text-muted">
          Linking GitHub lets a branch or pull request naming an issue key move
          that issue, and posts the linked issues back on the pull request.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the GitHub connection.')}
        />
      )}
      {installError !== null && (
        <ErrorAlert
          message={errorMessage(installError, 'Could not start the install.')}
        />
      )}
      {disconnectError !== null && (
        <ErrorAlert
          message={errorMessage(
            disconnectError,
            'Could not disconnect GitHub.'
          )}
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

      {isLoading ? (
        <Spinner label="Loading the GitHub connection" />
      ) : notConfigured ? (
        <div className="flex flex-wrap items-start gap-3 rounded-md border border-line p-4">
          <Badge>Not configured</Badge>
          <p className="min-w-0 flex-1 text-sm text-text-muted">
            The GitHub App is not set up for this environment yet, so there is
            nothing to connect to. A software engineer configures it once and
            this section starts working for every workspace.
          </p>
        </div>
      ) : installation === null ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-line p-4">
          <Badge>Not connected</Badge>
          <p className="min-w-0 flex-1 text-sm">
            This workspace is not connected to GitHub.
          </p>
          <Button variant="primary" onClick={onInstall} disabled={starting}>
            {starting ? 'Opening GitHub' : 'Install the GitHub App'}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-3 rounded-md border border-line p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone="success">Connected</Badge>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  Connected to {installation.account_login}
                </p>
                <p className="text-xs text-text-muted">
                  {installation.repository_selection === 'all'
                    ? 'Every repository'
                    : `${String(installation.repository_count)} selected repositories`}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <a
                  className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-line-strong bg-bg px-2 text-xs font-medium whitespace-nowrap text-text transition-colors duration-100 hover:bg-raised"
                  href={installation.html_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Manage on GitHub
                  <LuExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
                </a>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    void disconnect().catch(() => undefined);
                  }}
                >
                  Disconnect
                </Button>
              </div>
            </div>
            <p className="text-xs text-text-faint">
              Disconnecting stops this workspace reading the installation.
              Removing the App itself is done on GitHub.
            </p>
          </div>

          {repositories === null ||
          repositories === undefined ||
          repositories.length === 0 ? (
            <p className="text-sm text-text-muted">
              The installation can see no repositories yet.
            </p>
          ) : (
            <div className="rounded-md border border-line">
              <div
                className={`${COLUMNS} h-8 border-b border-line bg-surface text-xs font-medium text-text-muted`}
              >
                <span>Repository</span>
                <span>Team</span>
              </div>
              <ul>
                {repositories.map((repo) => (
                  <li
                    key={repo.repository_id}
                    className={`${COLUMNS} h-row border-b border-line transition-colors duration-100 last:border-b-0 hover:bg-surface`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-xs font-medium text-text">
                        {repo.full_name}
                      </span>
                      <Badge>{repo.private ? 'Private' : 'Public'}</Badge>
                    </div>
                    <SelectField
                      id={`repo-team-${repo.repository_id}`}
                      label="Team"
                      hideLabel
                      className="w-40"
                      value={repo.team_id ?? ''}
                      onChange={(event) => {
                        void pin({
                          repositoryId: repo.repository_id,
                          teamId:
                            event.target.value === ''
                              ? null
                              : event.target.value,
                        }).catch(() => undefined);
                      }}
                    >
                      <option value="">Every team</option>
                      {(teams ?? []).map((team) => (
                        <option key={team.id} value={team.id}>
                          {team.name}
                        </option>
                      ))}
                    </SelectField>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default GithubSection;
