/**
 * The GitHub App installation of one workspace: installing it, seeing the
 * repositories it can reach, pointing each at a project, and disconnecting.
 *
 * The install URL carries a signed state that expires, so it is fetched when
 * the button is pressed rather than held from the page load. Disconnecting only
 * forgets the installation on this side, because removing the App itself is a
 * GitHub setting this cannot reach on the workspace's behalf, so the link to do
 * that is offered alongside.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  deleteInstallation,
  getInstallUrl,
  getInstallation,
  linkRepository,
  listRepositories,
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

/** Shows the installation, its repositories, and the install and remove actions. */
export const GithubSection: React.FC<GithubSectionProps> = ({ workspace }) => {
  const auth = useQueryAuth();
  const installKey = installationKey(workspace.id);
  const reposKey = repositoriesKey(workspace.id);
  const [installError, setInstallError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);

  const {
    data: installation,
    error,
    isLoading,
  } = usePolledQuery(({ signal }) => getInstallation(workspace.id, signal), {
    intervalMs: POLL_MS,
    queryKey: installKey,
    auth,
  });

  const { data: repositories, error: reposError } = usePolledQuery(
    ({ signal }) => listRepositories(workspace.id, signal),
    { intervalMs: POLL_MS, queryKey: reposKey, auth }
  );

  const { data: projects } = usePolledQuery(
    ({ signal }) => listProjects(workspace.id, signal),
    { intervalMs: POLL_MS, queryKey: projectsKey(workspace.id), auth }
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

  const onInstall = (): void => {
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
      ) : installation === null || installation === undefined ? (
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
