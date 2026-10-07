/**
 * One team's releases, newest first. Each row is a record of what shipped:
 * its name and version, the furthest stage it reached, how many issues it
 * carried, what reported it and the commit it was cut from.
 *
 * Most releases arrive on their own from GitHub deployments, the API, the
 * CLI or MCP, so the page is a ledger first. A release can still be recorded
 * by hand, which opens it once it lands so the stages and issues can be
 * checked.
 */

import React, { useCallback, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { LuGitCommitHorizontal, LuPlus, LuRocket } from 'react-icons/lu';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  createRelease,
  getReleasePipeline,
  listReleases,
} from '../../api/releases';
import { ErrorAlert } from '../../components/ui/alert';
import Badge from '../../components/ui/badge';
import Button from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import EmptyState from '../../components/ui/empty-state';
import Field from '../../components/ui/field';
import { Textarea } from '../../components/ui/input';
import Label from '../../components/ui/label';
import RelativeTime from '../../components/ui/relative-time';
import { SelectField } from '../../components/ui/select';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import TeamTabs from '../../components/workspace/TeamTabs';
import TeamTitle from '../../components/workspace/TeamTitle';
import { useCursorPages, type CursorPage } from '../../hooks/useCursorPages';
import { useShortcut } from '../../hooks/useShortcuts';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { releasePath } from '../../lib/paths';
import { releasePipelineKey, releasesKey } from '../../lib/queryKeys';
import {
  parseIssueRefs,
  releaseSourceLabel,
  shortSha,
} from '../../lib/releases';
import type {
  PipelineStageRead,
  ReleaseCreate,
  ReleaseRead,
} from '../../types/Api';

/** How often the first page re-reads. */
const POLL_MS = 60000;

/** How many releases one page carries. */
const PAGE_SIZE = 50;

/** What the detail page is told about a release that was just recorded. */
export interface ReleaseCreatedState {
  skippedIssues: string[];
}

/** Joins a later page onto the rows held, dropping any repeated release. */
const mergeReleases = (
  held: ReleaseRead[],
  incoming: ReleaseRead[]
): ReleaseRead[] => {
  const seen = new Set(held.map((row) => row.release_id));
  return [...held, ...incoming.filter((row) => !seen.has(row.release_id))];
};

/** Props for ReleaseRow: one release, where it opens and the final stage. */
interface ReleaseRowProps {
  release: ReleaseRead;
  href: string;
  finalStageId: string | null;
}

/** One release as a dense row that opens its page. */
const ReleaseRow: React.FC<ReleaseRowProps> = ({
  release,
  href,
  finalStageId,
}) => {
  const stage = release.current_stage ?? null;
  const issues =
    release.issue_count === 1
      ? '1 issue'
      : `${String(release.issue_count)} issues`;
  return (
    <li className="group/row relative flex h-11 items-center gap-3 border-b border-line px-3 transition-colors duration-100 last:border-b-0 hover:bg-surface">
      <Link
        to={href}
        aria-label={release.name}
        className="absolute inset-0 rounded-md focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none focus-visible:ring-inset"
      />
      <LuRocket
        aria-hidden="true"
        className="pointer-events-none h-3.5 w-3.5 shrink-0 text-text-faint"
      />
      <span className="pointer-events-none min-w-0 flex-1 truncate text-sm font-medium">
        {release.name}
        {release.version !== null &&
          release.version !== undefined &&
          release.version !== release.name && (
            <span className="ml-2 font-normal text-text-muted">
              {release.version}
            </span>
          )}
      </span>
      {stage !== null && (
        <Badge
          tone={stage.stage_id === finalStageId ? 'success' : 'accent'}
          className="pointer-events-none shrink-0"
        >
          {stage.name}
        </Badge>
      )}
      <span className="pointer-events-none hidden w-20 shrink-0 text-right text-xs text-text-muted tabular-nums sm:block">
        {issues}
      </span>
      <span className="pointer-events-none hidden w-32 shrink-0 truncate text-xs text-text-muted md:block">
        {releaseSourceLabel(release.source)}
      </span>
      <span className="pointer-events-none hidden w-56 shrink-0 items-center gap-1 truncate font-mono text-xs text-text-muted lg:flex">
        {release.sha !== null && release.sha !== undefined && (
          <>
            <LuGitCommitHorizontal
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-text-faint"
            />
            <span className="truncate">
              {release.repository !== null && release.repository !== undefined
                ? `${release.repository}@${shortSha(release.sha)}`
                : shortSha(release.sha)}
            </span>
          </>
        )}
      </span>
      <RelativeTime
        value={release.created_at}
        className="pointer-events-none w-16 shrink-0 text-right"
      />
    </li>
  );
};

/** Props for NewReleaseDialog: the team, its stages, and what to do on success. */
interface NewReleaseDialogProps {
  workspaceId: string;
  teamId: string;
  stages: PipelineStageRead[];
  onClose: () => void;
  onCreated: (releaseId: string, skippedIssues: string[]) => void;
}

/** Records a release by hand: name, version, stage, issues and description. */
const NewReleaseDialog: React.FC<NewReleaseDialogProps> = ({
  workspaceId,
  teamId,
  stages,
  onClose,
  onCreated,
}) => {
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [stage, setStage] = useState('');
  const [issues, setIssues] = useState('');
  const [description, setDescription] = useState('');

  const {
    mutate: create,
    isMutating: isCreating,
    error: createError,
  } = useMutationWithRefetch(
    (body: ReleaseCreate) => createRelease(workspaceId, teamId, body),
    releasesKey(workspaceId, teamId)
  );

  const submit = (): void => {
    const refs = parseIssueRefs(issues);
    const body: ReleaseCreate = {
      ...(name.trim() === '' ? {} : { name: name.trim() }),
      ...(version.trim() === '' ? {} : { version: version.trim() }),
      ...(stage === '' ? {} : { stage }),
      ...(refs.length === 0 ? {} : { issues: refs }),
      ...(description.trim() === '' ? {} : { description: description.trim() }),
    };
    void create(body)
      .then((release) => {
        onCreated(release.release_id, release.skipped_issues ?? []);
      })
      .catch(() => undefined);
  };

  const firstStage = stages[0];

  return (
    <Dialog open title="New release" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <ErrorAlert
          message={
            createError === null
              ? null
              : errorMessage(createError, 'Could not record that release.')
          }
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="new-release-name"
            label="Name"
            placeholder="Defaults to the date and short sha"
            maxLength={120}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <Field
            id="new-release-version"
            label="Version"
            placeholder="Optional, such as 1.4.0"
            maxLength={120}
            value={version}
            onChange={(event) => {
              setVersion(event.target.value);
            }}
          />
        </div>
        <SelectField
          id="new-release-stage"
          label="Stage"
          value={stage}
          onChange={(event) => {
            setStage(event.target.value);
          }}
        >
          <option value="">
            {firstStage === undefined
              ? 'First stage'
              : `First stage (${firstStage.name})`}
          </option>
          {stages.map((row) => (
            <option key={row.stage_id} value={row.stage_id}>
              {row.name}
            </option>
          ))}
        </SelectField>
        <Field
          id="new-release-issues"
          label="Issues"
          hint="Issue keys, separated by commas or spaces."
          placeholder="ENG-12, ENG-14"
          value={issues}
          onChange={(event) => {
            setIssues(event.target.value);
          }}
        />
        <div className="space-y-1">
          <Label htmlFor="new-release-description">Description</Label>
          <Textarea
            id="new-release-description"
            rows={3}
            maxLength={8000}
            placeholder="Optional"
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={isCreating}>
            {isCreating ? 'Recording' : 'Record release'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

/** The releases of the team named by the route's key prefix. */
export const Releases: React.FC = () => {
  const { keyPrefix, slug } = useParams<{ slug: string; keyPrefix: string }>();
  const { workspace } = useWorkspace();
  const auth = useQueryAuth();
  const navigate = useNavigate();
  const {
    team,
    workspaceId,
    isLoading: isResolving,
    notFound,
    error: teamsError,
  } = useTeam(keyPrefix);
  const [isCreating, setIsCreating] = useState(false);

  const teamId = team?.id ?? '';
  const enabled = workspaceId !== '' && teamId !== '';

  const read = useCallback(
    async (
      cursor: string | undefined,
      signal?: AbortSignal
    ): Promise<CursorPage<ReleaseRead>> => {
      const page = await listReleases(
        workspaceId,
        teamId,
        cursor === undefined
          ? { limit: PAGE_SIZE }
          : { cursor, limit: PAGE_SIZE },
        signal
      );
      return { rows: page.releases, nextCursor: page.next_cursor ?? null };
    },
    [workspaceId, teamId]
  );

  const releases = useCursorPages(read, mergeReleases, {
    queryKey: releasesKey(workspaceId, teamId),
    enabled,
    intervalMs: POLL_MS,
  });

  const readPipeline = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      getReleasePipeline(workspaceId, teamId, signal),
    [workspaceId, teamId]
  );
  const { data: pipeline } = usePolledQuery(readPipeline, {
    intervalMs: POLL_MS,
    enabled,
    queryKey: releasePipelineKey(workspaceId, teamId),
    auth,
  });

  const canEdit = canWriteIssues(workspace?.role, team?.role);
  const stages = pipeline?.stages ?? [];
  const finalStageId = stages[stages.length - 1]?.stage_id ?? null;

  const closeDialog = useCallback((): void => {
    setIsCreating(false);
  }, []);

  useShortcut({
    keys: 'shift+n',
    label: 'New release',
    group: 'Releases',
    enabled: canEdit && team !== null && !isCreating,
    handler: (event) => {
      event?.preventDefault();
      setIsCreating(true);
    },
  });

  if (isResolving) {
    return (
      <WorkspaceShell title="Releases">
        {teamsError !== null && (
          <ErrorAlert
            message={errorMessage(teamsError, 'Could not load this team.')}
          />
        )}
        <Spinner label="Loading releases" />
      </WorkspaceShell>
    );
  }

  if (notFound || team === null) {
    return (
      <WorkspaceShell title="Releases">
        <EmptyState message="That team does not exist, or you are not a member of it." />
      </WorkspaceShell>
    );
  }

  const newButton = canEdit ? (
    <Button
      variant="primary"
      onClick={() => {
        setIsCreating(true);
      }}
    >
      <LuPlus aria-hidden="true" />
      New release
    </Button>
  ) : undefined;

  return (
    <WorkspaceShell
      title={<TeamTitle name={team.name} keyPrefix={team.key_prefix} />}
      toolbar={
        <TeamTabs
          slug={slug ?? ''}
          keyPrefix={team.key_prefix}
          current="releases"
        />
      }
      actions={newButton}
    >
      <div className="space-y-4">
        {releases.error !== null && releases.error !== undefined && (
          <ErrorAlert
            message={errorMessage(releases.error, 'Could not load releases.')}
          />
        )}

        {releases.isLoading && releases.rows.length === 0 ? (
          <Spinner label="Loading releases" />
        ) : releases.rows.length === 0 ? (
          <EmptyState
            icon={<LuRocket />}
            message="No releases yet. Releases are recorded from successful GitHub deployments, the API, the CLI with standupless release create, or MCP."
            action={newButton}
          />
        ) : (
          <>
            <ul className="rounded-md border border-line">
              {releases.rows.map((release) => (
                <ReleaseRow
                  key={release.release_id}
                  release={release}
                  href={releasePath(
                    slug ?? '',
                    team.key_prefix,
                    release.release_id
                  )}
                  finalStageId={finalStageId}
                />
              ))}
            </ul>
            {releases.hasMore && (
              <Button
                variant="ghost"
                size="sm"
                disabled={releases.isPaging}
                onClick={releases.loadMore}
              >
                {releases.isPaging ? 'Loading' : 'Load more'}
              </Button>
            )}
          </>
        )}
      </div>

      {isCreating && (
        <NewReleaseDialog
          workspaceId={workspaceId}
          teamId={teamId}
          stages={stages}
          onClose={closeDialog}
          onCreated={(releaseId, skippedIssues) => {
            setIsCreating(false);
            const state: ReleaseCreatedState = { skippedIssues };
            navigate(releasePath(slug ?? '', team.key_prefix, releaseId), {
              state,
            });
          }}
        />
      )}
    </WorkspaceShell>
  );
};

export default Releases;
