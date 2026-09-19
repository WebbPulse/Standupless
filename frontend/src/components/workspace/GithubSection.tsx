/**
 * The GitHub App installation of one workspace: installing it, seeing the
 * repositories it can reach, pointing each at a project, and disconnecting.
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
 * still retries, backing off to two minutes rather than the hook's five.
 *
 * The repositories and projects reads hang off the installation, so a workspace
 * with none asks for neither.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  deleteInstallation,
  getInstallUrl,
  linkRepository,
  listRepositories,
  readInstallation,
} from '../../api/integrations';
import { listProjects } from '../../api/projects';
import { errorMessage } from '../../lib/errors';
import {
  installationKey,
  projectsKey,
  repositoriesKey,
} from '../../lib/queryKeys';
import type { WorkspaceRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
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

/** Shows the installation, its repositories, and the install and remove actions. */
export const GithubSection: React.FC<GithubSectionProps> = ({ workspace }) => {
  const auth = useQueryAuth();
  const installKey = installationKey(workspace.id);
  const reposKey = repositoriesKey(workspace.id);
  const [installError, setInstallError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const [resumedAt, setResumedAt] = useState(0);
  const [settledKey, setSettledKey] = useState<number | null>(null);

  const polling = settledKey !== resumedAt;

  const {
    data: state,
    error,
    isLoading,
    refetch,
  } = usePolledQuery(({ signal }) => readInstallation(workspace.id, signal), {
    intervalMs: POLL_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
    enabled: polling,
    queryKey: installKey,
    auth,
  });

  const installation =
    state !== null && state.status === 'installed' ? state.installation : null;
  const notConfigured = state !== null && state.status === 'not_configured';
  const settled = state !== null && state.status !== 'installed';

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

  const { data: projects } = usePolledQuery(
    ({ signal }) => listProjects(workspace.id, signal),
    {
      intervalMs: POLL_MS,
      maxBackoffMs: MAX_BACKOFF_MS,
      enabled: installation !== null,
      queryKey: projectsKey(workspace.id),
      auth,
    }
  );

  const { mutate: disconnect, error: disconnectError } = useMutationWithRefetch(
    () => deleteInstallation(workspace.id),
    installKey
  );

  const { mutate: pin, error: pinError } = useMutationWithRefetch(
    (input: { repositoryId: string; projectId: string | null }) =>
      linkRepository(workspace.id, input.repositoryId, input.projectId),
    reposKey
  );

  const resume = useCallback((): void => {
    setResumedAt((previous) => previous + 1);
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

  if (settled && polling) setSettledKey(resumedAt);

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
      <h2 className="text-lg font-medium text-white">GitHub</h2>
      <p className="text-sm text-slate-400">
        Linking GitHub lets a branch or pull request naming an issue key move
        that issue, and posts the linked issues back on the pull request.
      </p>

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
        <div className="space-y-3 rounded-md border border-slate-700 p-4">
          <p className="text-sm text-slate-300">
            The GitHub App is not set up for this environment yet, so there is
            nothing to connect to. A software engineer configures it once and
            this section starts working for every workspace.
          </p>
        </div>
      ) : installation === null ? (
        <div className="space-y-3 rounded-md border border-slate-700 p-4">
          <p className="text-sm text-slate-300">
            This workspace is not connected to GitHub.
          </p>
          <Button onClick={onInstall} disabled={starting}>
            {starting ? 'Opening GitHub' : 'Install the GitHub App'}
          </Button>
        </div>
      ) : (
        <div className="space-y-4 rounded-md border border-slate-700 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm text-slate-100">
                Connected to {installation.account_login}
              </p>
              <p className="text-xs text-slate-500">
                {installation.repository_selection === 'all'
                  ? 'Every repository'
                  : `${String(installation.repository_count)} selected repositories`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                className="inline-flex items-center rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
                href={installation.html_url}
                target="_blank"
                rel="noreferrer"
              >
                Manage on GitHub
              </a>
              <Button
                variant="secondary"
                onClick={() => {
                  void disconnect().catch(() => undefined);
                }}
              >
                Disconnect
              </Button>
            </div>
          </div>

          <p className="text-xs text-slate-500">
            Disconnecting stops this workspace reading the installation.
            Removing the App itself is done on GitHub.
          </p>

          {repositories === null ||
          repositories === undefined ||
          repositories.length === 0 ? (
            <p className="text-sm text-slate-400">
              The installation can see no repositories yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {repositories.map((repo) => (
                <li
                  key={repo.repository_id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-700 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-100">
                      {repo.full_name}
                    </p>
                    <p className="text-xs text-slate-500">
                      {repo.private ? 'Private' : 'Public'}
                    </p>
                  </div>
                  <SelectField
                    id={`repo-project-${repo.repository_id}`}
                    label="Project"
                    value={repo.project_id ?? ''}
                    onChange={(event) => {
                      void pin({
                        repositoryId: repo.repository_id,
                        projectId:
                          event.target.value === '' ? null : event.target.value,
                      }).catch(() => undefined);
                    }}
                  >
                    <option value="">Every project</option>
                    {(projects ?? []).map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </SelectField>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};

export default GithubSection;
