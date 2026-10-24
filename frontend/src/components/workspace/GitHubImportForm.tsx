/**
 * The GitHub Issues import form. The workspace's installed GitHub App reads the
 * repository, so there is no key to paste: pick a repository the installation
 * covers, pick the team its issues go into, and start.
 *
 * When the App is not installed, is suspended, or covers no repositories, the
 * form says which and points at the place that fixes it instead of offering a
 * picker that would come back empty.
 */

import React, { useState } from 'react';
import { LuDownload } from 'react-icons/lu';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { readInstallation } from '../../api/integrations';
import {
  listGitHubImportRepositories,
  startGitHubImport,
} from '../../api/imports';
import { errorMessage } from '../../lib/errors';
import {
  githubImportRepositoriesKey,
  installationKey,
} from '../../lib/queryKeys';
import type { IssueImportRead, TeamRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import { LINK_CLASS, TextLink } from '../ui/link';
import { SelectField } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for GitHubImportForm: the workspace, its teams and the hook that starts a job. */
export interface GitHubImportFormProps {
  workspaceId: string;
  workspaceSlug: string;
  teams: TeamRead[];
  /** Whether another import is still running, which the server would refuse. */
  importing: boolean;
  /** Called with the queued job so the caller can refresh its list. */
  onStarted: (job: IssueImportRead) => void;
}

/** How often the installation and its repositories are read again. */
const POLL_MS = 60000;

/** Props for Notice: a resting state the form shows instead of its pickers. */
interface NoticeProps {
  title: string;
  children: React.ReactNode;
}

/** A bordered line that explains why there is nothing to import yet. */
const Notice: React.FC<NoticeProps> = ({ title, children }) => (
  <div
    role="status"
    className="space-y-0.5 rounded-md border border-line px-3 py-2.5"
  >
    <p className="text-sm font-medium text-text">{title}</p>
    <p className="text-xs text-text-faint">{children}</p>
  </div>
);

/** Lists the repositories the GitHub App covers and starts an import of one. */
export const GitHubImportForm: React.FC<GitHubImportFormProps> = ({
  workspaceId,
  workspaceSlug,
  teams,
  importing,
  onStarted,
}) => {
  const auth = useQueryAuth();
  const [repositoryId, setRepositoryId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<unknown>(null);

  const installation = usePolledQuery(
    ({ signal }) => readInstallation(workspaceId, signal),
    { intervalMs: POLL_MS, queryKey: installationKey(workspaceId), auth }
  );
  const state = installation.data ?? null;
  const live = state?.status === 'installed' && !state.installation.suspended;

  const repositories = usePolledQuery(
    ({ signal }) => listGitHubImportRepositories(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: live,
      queryKey: githubImportRepositoriesKey(workspaceId),
      auth,
    }
  );

  const repositoryList = repositories.data ?? [];
  const chosenRepository =
    repositoryList.find((row) => row.repository_id === repositoryId) ??
    repositoryList[0];
  const pinned = teams.find((team) => team.id === chosenRepository?.team_id);
  const defaultTeam = pinned ?? teams[0];
  const chosenTeam = teamId || (defaultTeam?.id ?? '');

  const settingsPath = `/w/${workspaceSlug}/settings/integrations`;

  if (installation.isLoading && state === null) {
    return <Spinner label="Checking the GitHub App" />;
  }
  if (installation.error !== null && installation.error !== undefined) {
    return (
      <ErrorAlert
        message={errorMessage(
          installation.error,
          'Could not read the GitHub App installation.'
        )}
      />
    );
  }
  if (state?.status === 'not_configured') {
    return (
      <Notice title="GitHub is not available here">
        This environment has no GitHub App configured, so repositories cannot
        be read.
      </Notice>
    );
  }
  if (state === null || state.status === 'not_installed') {
    return (
      <Notice title="The GitHub App is not installed">
        Install it from{' '}
        <TextLink to={settingsPath}>GitHub integration settings</TextLink> to
        import the Issues of the repositories it can see.
      </Notice>
    );
  }
  if (state.installation.suspended) {
    return (
      <Notice title="The GitHub App is suspended">
        {`${state.installation.account_login} has suspended the App, so its repositories cannot be read. Unsuspend it in `}
        <a
          href={state.installation.manage_url}
          target="_blank"
          rel="noreferrer"
          className={LINK_CLASS}
        >
          GitHub
        </a>
        , then come back here.
      </Notice>
    );
  }

  const onStart = (): void => {
    if (chosenRepository === undefined || chosenTeam === '') return;
    setStarting(true);
    setStartError(null);
    void startGitHubImport(workspaceId, {
      repository_id: chosenRepository.repository_id,
      team_id: chosenTeam,
    })
      .then((job) => {
        setRepositoryId('');
        setTeamId('');
        onStarted(job);
      })
      .catch((reason: unknown) => {
        setStartError(reason);
      })
      .finally(() => {
        setStarting(false);
      });
  };

  const canStart =
    chosenRepository !== undefined &&
    chosenTeam !== '' &&
    !importing &&
    !starting;

  return (
    <div className="space-y-6">
      {repositories.isLoading && repositoryList.length === 0 ? (
        <Spinner label="Loading repositories" />
      ) : repositories.error !== null && repositories.error !== undefined ? (
        <ErrorAlert
          message={errorMessage(
            repositories.error,
            'Could not load the repositories.'
          )}
        />
      ) : repositoryList.length === 0 ? (
        <Notice title="No repositories to import">
          {`The App on ${state.installation.account_login} cannot see any repositories. Grant it access in `}
          <a
            href={state.installation.manage_url}
            target="_blank"
            rel="noreferrer"
            className={LINK_CLASS}
          >
            GitHub
          </a>
          .
        </Notice>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              id="github-import-repository"
              label="Repository"
              value={chosenRepository?.repository_id ?? ''}
              disabled={starting}
              onChange={(event) => {
                setRepositoryId(event.target.value);
                setTeamId('');
              }}
            >
              {repositoryList.map((row) => (
                <option key={row.repository_id} value={row.repository_id}>
                  {row.private ? `${row.full_name} (private)` : row.full_name}
                </option>
              ))}
            </SelectField>
            <SelectField
              id="github-import-team"
              label="Team"
              value={chosenTeam}
              disabled={teams.length === 0 || starting}
              onChange={(event) => {
                setTeamId(event.target.value);
              }}
            >
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </SelectField>
          </div>
          <p className="text-xs text-text-faint">
            Titles, bodies, open and closed state, labels, assignees and
            comments come across. People match by linked GitHub account or
            email. Pull requests, and issues two way sync already mirrors, are
            skipped. Running it again updates what it imported before.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          size="sm"
          disabled={!canStart}
          onClick={onStart}
        >
          <LuDownload aria-hidden="true" className="h-3.5 w-3.5" />
          {importing
            ? 'Import in progress'
            : starting
              ? 'Starting import'
              : 'Import issues'}
        </Button>
      </div>

      {startError !== null && (
        <ErrorAlert
          message={errorMessage(startError, 'Could not start the import.')}
        />
      )}
    </div>
  );
};

export default GitHubImportForm;
