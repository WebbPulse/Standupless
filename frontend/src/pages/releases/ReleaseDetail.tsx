/**
 * One release: what it is, the commit it was cut from, every stage of the
 * team's pipeline with whether and when the release reached it, the issues
 * it carried and the notes built from them.
 *
 * The stages follow the pipeline's order rather than the order they were
 * reached, so a release that skipped one shows the gap. A stage that was
 * reached and has since left the pipeline is kept at the end, because it is
 * still part of the record.
 */

import React, { useCallback, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import {
  LuChevronRight,
  LuCircleCheck,
  LuCircleDashed,
  LuCopy,
  LuExternalLink,
  LuGitCommitHorizontal,
  LuGitPullRequest,
  LuMinus,
  LuPencil,
  LuTrash2,
} from 'react-icons/lu';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  addReleaseIssues,
  advanceRelease,
  deleteRelease,
  getRelease,
  getReleasePipeline,
  removeReleaseIssue,
  updateRelease,
} from '../../api/releases';
import ReleaseStagePill from '../../components/releases/ReleaseStagePill';
import { ErrorAlert } from '../../components/ui/alert';
import Badge from '../../components/ui/badge';
import Button, { IconButton } from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import EmptyState from '../../components/ui/empty-state';
import Field from '../../components/ui/field';
import { Input, Textarea } from '../../components/ui/input';
import Label from '../../components/ui/label';
import RelativeTime from '../../components/ui/relative-time';
import { SkeletonRows } from '../../components/ui/skeleton';
import StatusIcon from '../../components/ui/StatusIcon';
import TeamTabs from '../../components/workspace/TeamTabs';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues } from '../../lib/capabilities';
import { errorMessage, hasStatus } from '../../lib/errors';
import { issuePath, teamReleasesPath } from '../../lib/paths';
import {
  releaseKey,
  releasePipelineKey,
  releasesKey,
} from '../../lib/queryKeys';
import {
  githubCommitUrl,
  githubCompareUrl,
  isLinkableUrl,
  parseIssueRefs,
  releaseSourceLabel,
  shortSha,
} from '../../lib/releases';
import { isStatusCategory } from '../../lib/statusAppearance';
import { showErrorToast, showToast } from '../../lib/toast';
import type {
  PipelineStageRead,
  ReleaseDetailRead,
  ReleaseStageRead,
  ReleaseUpdate,
} from '../../types/Api';
import type { ReleaseCreatedState } from './Releases';

/** How often the release re-reads. */
const POLL_MS = 30000;

/** The link style an external reference in the header takes. */
const META_LINK =
  'inline-flex items-center gap-1 rounded-xs hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none';

/** One row of the stage timeline: a pipeline stage and what reached it. */
interface TimelineStage {
  stageId: string;
  name: string;
  reached: ReleaseStageRead | null;
  inPipeline: boolean;
}

/** The pipeline's stages in order, then any reached stage it no longer has. */
const timelineOf = (
  pipeline: PipelineStageRead[],
  reached: ReleaseStageRead[]
): TimelineStage[] => {
  const byId = new Map(reached.map((stage) => [stage.stage_id, stage]));
  const rows: TimelineStage[] = pipeline.map((stage) => ({
    stageId: stage.stage_id,
    name: stage.name,
    reached: byId.get(stage.stage_id) ?? null,
    inPipeline: true,
  }));
  const known = new Set(pipeline.map((stage) => stage.stage_id));
  for (const stage of reached) {
    if (!known.has(stage.stage_id)) {
      rows.push({
        stageId: stage.stage_id,
        name: stage.name,
        reached: stage,
        inPipeline: false,
      });
    }
  }
  return rows;
};

/** The value an optional text field patches to: trimmed, or null when blank. */
const optional = (value: string): string | null =>
  value.trim() === '' ? null : value.trim();

/** Props for EditReleaseDialog: the release and how to save it. */
interface EditReleaseDialogProps {
  release: ReleaseDetailRead;
  isSaving: boolean;
  error: unknown;
  onSave: (body: ReleaseUpdate) => void;
  onClose: () => void;
}

/** Edits a release's name, version, url and description. */
const EditReleaseDialog: React.FC<EditReleaseDialogProps> = ({
  release,
  isSaving,
  error,
  onSave,
  onClose,
}) => {
  const [name, setName] = useState(release.name);
  const [version, setVersion] = useState(release.version ?? '');
  const [url, setUrl] = useState(release.url ?? '');
  const [description, setDescription] = useState(release.description ?? '');

  const submit = (): void => {
    const body: ReleaseUpdate = {};
    if (name.trim() !== release.name) body.name = name.trim();
    if (optional(version) !== (release.version ?? null)) {
      body.version = optional(version);
    }
    if (optional(url) !== (release.url ?? null)) body.url = optional(url);
    if (optional(description) !== (release.description ?? null)) {
      body.description = optional(description);
    }
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    onSave(body);
  };

  return (
    <Dialog open title="Edit release" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <ErrorAlert
          message={
            error === null || error === undefined
              ? null
              : errorMessage(error, 'Could not save this release.')
          }
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="edit-release-name"
            label="Name"
            maxLength={120}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <Field
            id="edit-release-version"
            label="Version"
            placeholder="Optional"
            maxLength={120}
            value={version}
            onChange={(event) => {
              setVersion(event.target.value);
            }}
          />
        </div>
        <Field
          id="edit-release-url"
          label="URL"
          type="url"
          placeholder="https://"
          maxLength={2048}
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
          }}
        />
        <div className="space-y-1">
          <Label htmlFor="edit-release-description">Description</Label>
          <Textarea
            id="edit-release-description"
            rows={4}
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
          <Button
            type="submit"
            variant="primary"
            disabled={isSaving || name.trim() === ''}
          >
            {isSaving ? 'Saving' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

/** Props for StageTimeline: the stages and whether the caller may advance. */
interface StageTimelineProps {
  stages: TimelineStage[];
  canEdit: boolean;
  advancing: string | null;
  onAdvance: (stage: TimelineStage) => void;
}

/** Every stage in order, each reached or not, with when and what reported it. */
const StageTimeline: React.FC<StageTimelineProps> = ({
  stages,
  canEdit,
  advancing,
  onAdvance,
}) => (
  <ol className="rounded-md border border-line">
    {stages.map((stage) => {
      const reached = stage.reached;
      return (
        <li
          key={stage.stageId}
          className="flex min-h-row flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 last:border-b-0"
          data-testid="release-stage"
        >
          {reached === null ? (
            <LuCircleDashed
              aria-hidden="true"
              className="h-4 w-4 shrink-0 text-text-faint"
            />
          ) : (
            <LuCircleCheck
              aria-hidden="true"
              className="h-4 w-4 shrink-0 text-success"
            />
          )}
          <span
            className={
              reached === null
                ? 'text-sm text-text-muted'
                : 'text-sm font-medium'
            }
          >
            {stage.name}
          </span>
          <span className="sr-only">
            {reached === null ? 'Not reached' : 'Reached'}
          </span>
          {!stage.inPipeline && (
            <Badge tone="neutral">No longer in the pipeline</Badge>
          )}
          {reached !== null && (
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-text-muted">
              <RelativeTime value={reached.reached_at} />
              <span>{releaseSourceLabel(reached.source)}</span>
              {reached.environment !== null &&
                reached.environment !== undefined &&
                (isLinkableUrl(reached.url) ? (
                  <a
                    href={reached.url}
                    target="_blank"
                    rel="noreferrer"
                    className={`${META_LINK} font-mono`}
                  >
                    {reached.environment}
                    <LuExternalLink aria-hidden="true" className="h-3 w-3" />
                  </a>
                ) : (
                  <span className="font-mono">{reached.environment}</span>
                ))}
              {(reached.environment === null ||
                reached.environment === undefined) &&
                isLinkableUrl(reached.url) && (
                  <a
                    href={reached.url}
                    target="_blank"
                    rel="noreferrer"
                    className={META_LINK}
                  >
                    Open
                    <LuExternalLink aria-hidden="true" className="h-3 w-3" />
                  </a>
                )}
            </span>
          )}
          {reached === null && canEdit && stage.inPipeline && (
            <span className="ml-auto">
              <Button
                variant="ghost"
                size="sm"
                disabled={advancing !== null}
                onClick={() => {
                  onAdvance(stage);
                }}
              >
                {advancing === stage.stageId
                  ? 'Advancing'
                  : `Advance to ${stage.name}`}
              </Button>
            </span>
          )}
        </li>
      );
    })}
  </ol>
);

/** One release of the team named by the route's key prefix. */
export const ReleaseDetail: React.FC = () => {
  const { keyPrefix, releaseId } = useParams<{
    keyPrefix: string;
    releaseId: string;
  }>();
  const { workspace } = useWorkspace();
  const slug = workspace?.slug ?? '';
  const auth = useQueryAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    team,
    workspaceId,
    isLoading: isResolving,
    notFound,
    error: teamsError,
  } = useTeam(keyPrefix);
  const id = releaseId ?? '';
  const teamId = team?.id ?? '';
  const enabled = workspaceId !== '' && teamId !== '' && id !== '';

  const created = location.state as ReleaseCreatedState | null | undefined;
  const [skipped, setSkipped] = useState<string[]>(
    Array.isArray(created?.skippedIssues) ? created.skippedIssues : []
  );
  const [isEditing, setIsEditing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [advancing, setAdvancing] = useState<string | null>(null);
  const [issueText, setIssueText] = useState('');

  const queryKey = releaseKey(workspaceId, teamId, id);
  const listKey = releasesKey(workspaceId, teamId);

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      getRelease(workspaceId, teamId, id, signal),
    [workspaceId, teamId, id]
  );
  const { data, error, isLoading } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled,
    queryKey,
    auth,
  });
  const release: ReleaseDetailRead | undefined = data ?? undefined;

  const readPipeline = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      getReleasePipeline(workspaceId, teamId, signal),
    [workspaceId, teamId]
  );
  const { data: pipeline } = usePolledQuery(readPipeline, {
    intervalMs: POLL_MS,
    enabled: workspaceId !== '' && teamId !== '',
    queryKey: releasePipelineKey(workspaceId, teamId),
    auth,
  });

  const {
    mutate: save,
    isMutating: isSaving,
    error: saveError,
  } = useMutationWithRefetch(
    (body: ReleaseUpdate) => updateRelease(workspaceId, teamId, id, body),
    [queryKey, listKey]
  );

  const {
    mutate: remove,
    isMutating: isRemoving,
    error: removeError,
  } = useMutationWithRefetch(
    () => deleteRelease(workspaceId, teamId, id),
    listKey
  );

  const { mutate: advance, error: advanceError } = useMutationWithRefetch(
    (stage: string) => advanceRelease(workspaceId, teamId, id, { stage }),
    [queryKey, listKey]
  );

  const {
    mutate: addIssues,
    isMutating: isAddingIssues,
    error: addIssuesError,
  } = useMutationWithRefetch(
    (refs: string[]) => addReleaseIssues(workspaceId, teamId, id, refs),
    [queryKey, listKey]
  );

  const { mutate: dropIssue, error: dropIssueError } = useMutationWithRefetch(
    (ref: string) => removeReleaseIssue(workspaceId, teamId, id, ref),
    [queryKey, listKey]
  );

  const canEdit = canWriteIssues(workspace?.role, team?.role);

  const onAdvance = useCallback(
    (stage: TimelineStage): void => {
      setAdvancing(stage.stageId);
      void advance(stage.stageId)
        .then(() => {
          showToast(`Advanced to ${stage.name}`);
        })
        .catch(() => undefined)
        .finally(() => {
          setAdvancing(null);
        });
    },
    [advance]
  );

  const onAddIssues = (): void => {
    const refs = parseIssueRefs(issueText);
    if (refs.length === 0) return;
    void addIssues(refs)
      .then((result) => {
        setIssueText('');
        setSkipped(result.skipped_issues ?? []);
      })
      .catch(() => undefined);
  };

  const copyNotes = (notes: string): void => {
    const clipboard = globalThis.navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      showErrorToast('Could not copy the release notes.');
      return;
    }
    void clipboard
      .writeText(notes)
      .then(() => {
        showToast('Copied the release notes');
      })
      .catch(() => {
        showErrorToast('Could not copy the release notes.');
      });
  };

  const releasesHref = teamReleasesPath(slug, keyPrefix ?? '');
  const crumbs = (
    <span className="hidden shrink-0 items-center gap-1 text-sm text-text-muted sm:inline-flex">
      <Link
        to={releasesHref}
        className="rounded-xs hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
      >
        {team === null ? 'Releases' : `${team.name} releases`}
      </Link>
      <LuChevronRight
        className="h-3.5 w-3.5 text-text-faint"
        aria-hidden="true"
      />
    </span>
  );

  if (isResolving || (team !== null && isLoading && release === undefined)) {
    return (
      <WorkspaceShell title="Release" leading={crumbs}>
        {teamsError !== null && (
          <ErrorAlert
            message={errorMessage(teamsError, 'Could not load this team.')}
          />
        )}
        <SkeletonRows label="Loading release" />
      </WorkspaceShell>
    );
  }

  if (notFound || team === null || release === undefined) {
    return (
      <WorkspaceShell title="Release not found" leading={crumbs}>
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load this release.')}
          />
        )}
        <EmptyState message="That release does not exist, or you are not a member of its team." />
      </WorkspaceShell>
    );
  }

  const commitUrl = githubCommitUrl(release.repository, release.sha);
  const compareUrl = githubCompareUrl(
    release.repository,
    release.previous_sha,
    release.sha
  );
  const stages = timelineOf(pipeline?.stages ?? [], release.stages);
  const pullLabel =
    typeof release.pr_number === 'number'
      ? `Pull request #${String(release.pr_number)}`
      : null;
  const hasVersion =
    release.version !== null &&
    release.version !== undefined &&
    release.version !== '';
  const commitLabel =
    release.sha === null || release.sha === undefined
      ? null
      : release.repository !== null && release.repository !== undefined
        ? `${release.repository}@${shortSha(release.sha)}`
        : shortSha(release.sha);

  return (
    <WorkspaceShell
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{release.name}</span>
          {hasVersion && release.version !== release.name && (
            <span className="shrink-0 text-sm font-normal text-text-muted">
              {release.version}
            </span>
          )}
        </span>
      }
      leading={crumbs}
      toolbar={
        <TeamTabs slug={slug} keyPrefix={team.key_prefix} current="releases" />
      }
      actions={
        canEdit ? (
          <span className="flex items-center gap-1">
            <Button
              variant="secondary"
              onClick={() => {
                setIsEditing(true);
              }}
            >
              <LuPencil aria-hidden="true" />
              Edit
            </Button>
            <IconButton
              label={`Delete ${release.name}`}
              onClick={() => {
                setIsDeleting(true);
              }}
            >
              <LuTrash2 className="h-4 w-4" />
            </IconButton>
          </span>
        ) : undefined
      }
    >
      <div className="space-y-8">
        {skipped.length > 0 && (
          <div
            role="status"
            className="flex items-start justify-between gap-3 rounded-md border border-line bg-warning-soft px-3 py-2 text-sm text-warning"
          >
            <span>
              {`No issue in this team matched ${skipped.join(', ')}, so ${
                skipped.length === 1 ? 'it was' : 'they were'
              } left out.`}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSkipped([]);
              }}
            >
              Dismiss
            </Button>
          </div>
        )}
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not refresh this release.')}
          />
        )}

        <section aria-labelledby="release-summary" className="space-y-2">
          <h2 id="release-summary" className="sr-only">
            Summary
          </h2>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
            {release.current_stage !== null &&
              release.current_stage !== undefined && (
                <ReleaseStagePill
                  name={release.current_stage.name}
                  final={
                    release.current_stage.stage_id ===
                    pipeline?.stages[pipeline.stages.length - 1]?.stage_id
                  }
                />
              )}
            <span>{releaseSourceLabel(release.source)}</span>
            {commitLabel !== null &&
              (commitUrl === null ? (
                <span className="inline-flex items-center gap-1 font-mono">
                  <LuGitCommitHorizontal
                    aria-hidden="true"
                    className="h-3.5 w-3.5"
                  />
                  {commitLabel}
                </span>
              ) : (
                <a
                  href={commitUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={`${META_LINK} font-mono`}
                >
                  <LuGitCommitHorizontal
                    aria-hidden="true"
                    className="h-3.5 w-3.5"
                  />
                  {commitLabel}
                </a>
              ))}
            {compareUrl !== null && (
              <a
                href={compareUrl}
                target="_blank"
                rel="noreferrer"
                className={META_LINK}
              >
                {`Compare with ${shortSha(release.previous_sha ?? '')}`}
                <LuExternalLink aria-hidden="true" className="h-3 w-3" />
              </a>
            )}
            {pullLabel !== null &&
              (isLinkableUrl(release.pr_url) ? (
                <a
                  href={release.pr_url}
                  target="_blank"
                  rel="noreferrer"
                  className={META_LINK}
                >
                  <LuGitPullRequest
                    aria-hidden="true"
                    className="h-3.5 w-3.5"
                  />
                  {pullLabel}
                </a>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <LuGitPullRequest
                    aria-hidden="true"
                    className="h-3.5 w-3.5"
                  />
                  {pullLabel}
                </span>
              ))}
            {isLinkableUrl(release.url) && (
              <a
                href={release.url}
                target="_blank"
                rel="noreferrer"
                className={META_LINK}
              >
                Open release
                <LuExternalLink aria-hidden="true" className="h-3 w-3" />
              </a>
            )}
            {isLinkableUrl(release.github_release_url) && (
              <a
                href={release.github_release_url}
                target="_blank"
                rel="noreferrer"
                className={META_LINK}
              >
                GitHub Release
                <LuExternalLink aria-hidden="true" className="h-3 w-3" />
              </a>
            )}
            <span className="inline-flex items-center gap-1">
              Recorded <RelativeTime value={release.created_at} />
            </span>
          </div>
          {release.description !== null &&
            release.description !== undefined &&
            release.description !== '' && (
              <p className="text-sm whitespace-pre-wrap text-text">
                {release.description}
              </p>
            )}
        </section>

        <section aria-labelledby="release-stages" className="space-y-3">
          <h2 id="release-stages" className="text-sm font-medium">
            Stages
          </h2>
          <ErrorAlert
            message={
              advanceError === null
                ? null
                : errorMessage(advanceError, 'Could not advance this release.')
            }
          />
          {stages.length === 0 ? (
            <p className="text-sm text-text-muted">No stages yet.</p>
          ) : (
            <StageTimeline
              stages={stages}
              canEdit={canEdit}
              advancing={advancing}
              onAdvance={onAdvance}
            />
          )}
        </section>

        <section aria-labelledby="release-issues" className="space-y-3">
          <h2 id="release-issues" className="text-sm font-medium">
            Issues
            <span className="ml-2 text-text-faint tabular-nums">
              {String(release.issues.length)}
            </span>
          </h2>
          <ErrorAlert
            message={
              dropIssueError === null
                ? null
                : errorMessage(dropIssueError, 'Could not remove that issue.')
            }
          />
          {release.issues.length === 0 ? (
            <p className="text-sm text-text-muted">
              No issues in this release yet.
            </p>
          ) : (
            <ul className="rounded-md border border-line">
              {release.issues.map((issue) => {
                const category =
                  typeof issue.status_category === 'string' &&
                  isStatusCategory(issue.status_category)
                    ? issue.status_category
                    : null;
                return (
                  <li
                    key={issue.issue_id}
                    className="group/row relative flex h-10 items-center gap-3 border-b border-line px-3 transition-colors duration-100 last:border-b-0 hover:bg-surface"
                  >
                    <Link
                      to={issuePath(slug, issue.key)}
                      aria-label={`${issue.key} ${issue.title}`}
                      data-hover="parent"
                      className="absolute inset-0 rounded-md focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none focus-visible:ring-inset"
                    />
                    <span className="pointer-events-none flex shrink-0">
                      {category === null ? (
                        <LuCircleDashed
                          aria-hidden="true"
                          className="h-3.5 w-3.5 text-text-faint"
                        />
                      ) : (
                        <StatusIcon status={{ category }} />
                      )}
                    </span>
                    <span className="pointer-events-none w-16 shrink-0 font-mono text-xs text-text-muted">
                      {issue.key}
                    </span>
                    <span className="pointer-events-none min-w-0 flex-1 truncate text-sm">
                      {issue.title}
                    </span>
                    {canEdit && (
                      <span className="relative z-10 flex shrink-0 items-center opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
                        <IconButton
                          label={`Remove ${issue.key} from this release`}
                          size="sm"
                          onClick={() => {
                            void dropIssue(issue.key).catch(() => undefined);
                          }}
                        >
                          <LuMinus className="h-3.5 w-3.5" />
                        </IconButton>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {canEdit && (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                onAddIssues();
              }}
            >
              <label htmlFor="release-add-issues" className="sr-only">
                Add issues
              </label>
              <Input
                id="release-add-issues"
                className="min-w-0 flex-1"
                placeholder="Add issues by key, such as ENG-12, ENG-14"
                value={issueText}
                onChange={(event) => {
                  setIssueText(event.target.value);
                }}
              />
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                disabled={
                  isAddingIssues || parseIssueRefs(issueText).length === 0
                }
              >
                {isAddingIssues ? 'Adding' : 'Add issues'}
              </Button>
            </form>
          )}
          <ErrorAlert
            message={
              addIssuesError === null
                ? null
                : errorMessage(addIssuesError, 'Could not add those issues.')
            }
          />
        </section>

        <section aria-labelledby="release-notes" className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 id="release-notes" className="text-sm font-medium">
              Notes
            </h2>
            <Button
              variant="ghost"
              size="sm"
              disabled={release.notes === ''}
              onClick={() => {
                copyNotes(release.notes);
              }}
            >
              <LuCopy aria-hidden="true" />
              Copy
            </Button>
          </div>
          {release.notes === '' ? (
            <p className="text-sm text-text-muted">
              Notes are built from the issues in this release.
            </p>
          ) : (
            <pre
              className="overflow-x-auto rounded-md border border-line bg-surface p-4 font-mono text-xs whitespace-pre-wrap text-text"
              data-testid="release-notes"
            >
              {release.notes}
            </pre>
          )}
        </section>
      </div>

      {isEditing && (
        <EditReleaseDialog
          release={release}
          isSaving={isSaving}
          error={saveError}
          onClose={() => {
            setIsEditing(false);
          }}
          onSave={(body) => {
            void save(body)
              .then(() => {
                setIsEditing(false);
                showToast('Release saved');
              })
              .catch(() => undefined);
          }}
        />
      )}

      {isDeleting && (
        <Dialog
          open
          size="sm"
          title={`Delete ${release.name}`}
          description="The release and its stage history are removed. The issues it carried are not changed."
          onClose={() => {
            setIsDeleting(false);
          }}
        >
          <div className="space-y-4">
            <ErrorAlert
              message={
                removeError === null
                  ? null
                  : hasStatus(removeError, 403)
                    ? 'Only a team admin can delete a release.'
                    : errorMessage(
                        removeError,
                        'Could not delete this release.'
                      )
              }
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setIsDeleting(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={isRemoving}
                onClick={() => {
                  void remove()
                    .then(() => {
                      showToast(`Deleted ${release.name}`);
                      void navigate(releasesHref);
                    })
                    .catch(() => undefined);
                }}
              >
                {isRemoving ? 'Deleting' : 'Delete release'}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </WorkspaceShell>
  );
};

export default ReleaseDetail;
