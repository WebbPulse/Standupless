/**
 * One team's releases as a dense list grouped by where they stand: in
 * progress while a release is still on its way through the pipeline, and
 * released once it reaches the final stage. Each row shows the stage pill,
 * the name and version, how far its issues have come, the repository and
 * commit, when it last moved and who recorded it.
 *
 * Most releases arrive on their own from GitHub deployments, the API, the
 * CLI or MCP, so the page is a ledger first. The repository and stage
 * filters live in the URL so a filtered list can be shared, j and k move
 * through the rows and Enter opens one. A release can still be recorded by
 * hand, which opens it once it lands so the stages and issues can be checked.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import {
  LuChevronRight,
  LuCircleCheck,
  LuCircleDashed,
  LuGitCommitHorizontal,
  LuGithub,
  LuListFilter,
  LuPencilLine,
  LuPlus,
  LuRocket,
  LuSettings,
  LuTerminal,
  LuX,
} from 'react-icons/lu';
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import {
  createRelease,
  getReleasePipeline,
  listReleases,
} from '../../api/releases';
import ReleaseProgress from '../../components/releases/ReleaseProgress';
import ReleaseStagePill, {
  ReleaseStageDot,
} from '../../components/releases/ReleaseStagePill';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import Button from '../../components/ui/button';
import { Combobox, type ComboboxOption } from '../../components/ui/combobox';
import Dialog from '../../components/ui/dialog';
import EmptyState from '../../components/ui/empty-state';
import Field from '../../components/ui/field';
import { Textarea } from '../../components/ui/input';
import Label from '../../components/ui/label';
import { Popover } from '../../components/ui/popover';
import RelativeTime from '../../components/ui/relative-time';
import { SelectField } from '../../components/ui/select';
import { SkeletonRows } from '../../components/ui/skeleton';
import Spinner from '../../components/ui/spinner';
import Tooltip from '../../components/ui/tooltip';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import TeamTabs from '../../components/workspace/TeamTabs';
import TeamTitle from '../../components/workspace/TeamTitle';
import { useCursorPages, type CursorPage } from '../../hooks/useCursorPages';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import { useShortcut } from '../../hooks/useShortcuts';
import { useStoredSet } from '../../hooks/useStoredSet';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { canWriteIssues } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { personAvatar, personLabel } from '../../lib/issuePeople';
import { releasePath, teamSettingsPath } from '../../lib/paths';
import { releasePipelineKey, releasesKey } from '../../lib/queryKeys';
import {
  isGithubRepository,
  parseIssueRefs,
  releaseSourceLabel,
  shortSha,
} from '../../lib/releases';
import type {
  MemberRead,
  PipelineStageRead,
  ReleaseCreate,
  ReleaseRead,
} from '../../types/Api';

/** How often the first page re-reads. */
const POLL_MS = 60000;

/** How many releases one page carries. */
const PAGE_SIZE = 50;

/** The filter value for a release that reached no stage. */
const DRAFT = 'draft';

/** The filter value for a release with no repository. */
const NO_REPOSITORY = 'none';

/** The grid every row lines up on. */
const GRID =
  'grid grid-cols-[6.5rem_minmax(0,1fr)_4rem] items-center gap-3 md:grid-cols-[6.5rem_minmax(0,1fr)_7.5rem_minmax(0,16rem)_4.5rem_1.25rem]';

/** What the detail page is told about a release that was just recorded. */
export interface ReleaseCreatedState {
  skippedIssues: string[];
}

/** Where a release stands: still moving through the pipeline, or done. */
type ReleaseGroupKey = 'progress' | 'released';

/** One group of rows as the list draws it. */
interface ReleaseGroup {
  key: ReleaseGroupKey;
  label: string;
  rows: ReleaseRead[];
}

/** Joins a later page onto the rows held, dropping any repeated release. */
const mergeReleases = (
  held: ReleaseRead[],
  incoming: ReleaseRead[]
): ReleaseRead[] => {
  const seen = new Set(held.map((row) => row.release_id));
  return [...held, ...incoming.filter((row) => !seen.has(row.release_id))];
};

/** Splits a comma separated URL parameter into its values. */
const listParam = (raw: string | null): string[] =>
  (raw ?? '').split(',').filter((value) => value !== '');

/** The value a release matches in the stage filter. */
const stageValue = (release: ReleaseRead): string =>
  release.current_stage?.stage_id ?? DRAFT;

/** The value a release matches in the repository filter. */
const repositoryValue = (release: ReleaseRead): string =>
  release.repository ?? NO_REPOSITORY;

/** Props for FilterButton: one filter's options and what is chosen. */
interface FilterButtonProps {
  field: string;
  options: ComboboxOption[];
  selected: string[];
  onSelect: (value: string) => void;
}

/** A toolbar chip that opens one filter's options, several of which may be chosen. */
const FilterButton: React.FC<FilterButtonProps> = ({
  field,
  options,
  selected,
  onSelect,
}) => {
  const chosen = options.filter((option) => selected.includes(option.value));
  const summary =
    chosen.length === 0
      ? null
      : chosen.length === 1
        ? (chosen[0]?.label ?? '')
        : `${String(chosen.length)} selected`;
  return (
    <Popover
      label={field}
      contentClassName="w-64"
      trigger={(trigger) => (
        <button
          type="button"
          {...trigger}
          aria-label={`${field} filter${summary === null ? '' : `: ${summary}`}`}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-sm border px-2 text-xs transition-colors duration-100',
            summary === null
              ? 'border-dashed border-line text-text-muted hover:border-line-strong hover:text-text'
              : 'border-line bg-raised text-text hover:border-line-strong'
          )}
        >
          <span className={summary === null ? '' : 'text-text-muted'}>
            {field}
          </span>
          {summary !== null && (
            <span className="max-w-40 truncate font-medium">{summary}</span>
          )}
        </button>
      )}
    >
      {() => (
        <Combobox
          label={field}
          placeholder={`Filter by ${field.toLowerCase()}`}
          options={options}
          selected={selected}
          multiple
          onSelect={onSelect}
        />
      )}
    </Popover>
  );
};

/** How a release with no known person reads in the creator tooltip. */
const RECORDED_BY: Record<string, string> = {
  github_deployment: 'Recorded from a GitHub deployment',
  api: 'Recorded through the API',
  manual: 'Recorded by hand',
};

/** The icon that stands for what recorded a release with no known person. */
const SourceIcon: React.FC<{ source: string }> = ({ source }) => {
  const Icon =
    source === 'github_deployment'
      ? LuGithub
      : source === 'manual'
        ? LuPencilLine
        : LuTerminal;
  return (
    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-line text-text-faint">
      <Icon aria-hidden="true" className="h-3 w-3" />
    </span>
  );
};

/** Props for ReleaseRow: one release, where it opens and how it is drawn. */
interface ReleaseRowProps {
  release: ReleaseRead;
  href: string;
  final: boolean;
  creator: MemberRead | undefined;
  isActive: boolean;
  rowRef: (node: HTMLElement | null) => void;
  onPointerEnter: () => void;
}

/** One release as a dense row that opens its page. */
const ReleaseRow: React.FC<ReleaseRowProps> = ({
  release,
  href,
  final,
  creator,
  isActive,
  rowRef,
  onPointerEnter,
}) => {
  const stage = release.current_stage ?? null;
  const version =
    release.version !== null &&
    release.version !== undefined &&
    release.version !== release.name
      ? release.version
      : null;
  const repository = release.repository ?? null;
  const sha = release.sha ?? null;
  const source = releaseSourceLabel(release.source);
  const createdBy =
    creator === undefined
      ? (RECORDED_BY[release.source] ?? `Recorded from ${source}`)
      : `Created by ${personLabel(creator)}`;
  return (
    <li
      ref={rowRef}
      onPointerEnter={onPointerEnter}
      aria-current={isActive ? 'true' : undefined}
      className={cn(
        GRID,
        'relative h-row border-b border-line px-4 text-sm transition-colors duration-100 hover:bg-surface has-[a:active]:bg-raised lg:px-6',
        isActive &&
          'bg-surface before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent'
      )}
    >
      <Link
        to={href}
        aria-label={release.name}
        data-hover="parent"
        className="absolute inset-0 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none focus-visible:ring-inset"
      />
      <div className="pointer-events-none flex min-w-0">
        <ReleaseStagePill name={stage?.name ?? null} final={final} />
      </div>
      <div className="pointer-events-none flex min-w-0 items-baseline gap-2">
        <span className="truncate font-medium text-text">{release.name}</span>
        {version !== null && (
          <span className="shrink-0 text-xs text-text-muted">{version}</span>
        )}
      </div>
      <div className="hidden md:flex">
        <ReleaseProgress
          total={release.issue_count}
          counts={release.status_counts ?? {}}
        />
      </div>
      <div className="pointer-events-none hidden min-w-0 items-center gap-1.5 text-xs text-text-muted md:flex">
        {repository === null && sha === null ? (
          <span className="truncate text-text-faint">{source}</span>
        ) : (
          <>
            {isGithubRepository(repository) ? (
              <LuGithub
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-text-faint"
              />
            ) : (
              <LuGitCommitHorizontal
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-text-faint"
              />
            )}
            {repository !== null && (
              <span className="truncate">{repository}</span>
            )}
            {sha !== null && (
              <span className="shrink-0 font-mono text-text-faint">
                {shortSha(sha)}
              </span>
            )}
          </>
        )}
      </div>
      <div className="flex justify-end">
        <RelativeTime value={stage?.reached_at ?? release.created_at} />
      </div>
      <div className="hidden justify-end md:flex">
        <Tooltip text={createdBy} side="top">
          <span aria-label={createdBy} className="inline-flex">
            {creator === undefined ? (
              <SourceIcon source={release.source} />
            ) : (
              <Avatar
                name={personLabel(creator)}
                src={personAvatar(creator)}
                size="xs"
              />
            )}
          </span>
        </Tooltip>
      </div>
    </li>
  );
};

/** Props for ReleaseGroupHeader: the group, whether it is open and its toggle. */
interface ReleaseGroupHeaderProps {
  group: ReleaseGroup;
  open: boolean;
  onToggle: () => void;
}

/** The sticky, collapsible header over one group with its count. */
const ReleaseGroupHeader: React.FC<ReleaseGroupHeaderProps> = ({
  group,
  open,
  onToggle,
}) => {
  const Glyph = group.key === 'released' ? LuCircleCheck : LuCircleDashed;
  return (
    <div className="group/header sticky top-0 z-20 flex h-9 items-center gap-2 border-b border-line bg-surface px-4 transition-colors duration-100 hover:bg-raised lg:px-6">
      <button
        type="button"
        aria-expanded={open}
        data-hover="parent"
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
      >
        <LuChevronRight
          aria-hidden="true"
          className={cn(
            'h-3.5 w-3.5 text-text-faint transition-transform duration-100',
            open && 'rotate-90'
          )}
        />
        <Glyph
          aria-hidden="true"
          className={cn(
            'h-3.5 w-3.5',
            group.key === 'released' ? 'text-success' : 'text-accent'
          )}
        />
        <span className="truncate">{group.label}</span>
        <span className="text-xs font-normal text-text-faint tabular-nums">
          {String(group.rows.length)}
        </span>
      </button>
    </div>
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
  const [params, setParams] = useSearchParams();
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
  const isMember = workspace !== null && workspace.role !== 'guest';

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
  const members = useWorkspaceMembers(workspaceId, isMember);

  const [folded, toggleFolded] = useStoredSet(
    teamId === '' ? undefined : `standupless.releases.folded.${teamId}`
  );

  const stageParam = params.get('stage');
  const repositoryParam = params.get('repo');
  const stageFilter = useMemo(() => listParam(stageParam), [stageParam]);
  const repositoryFilter = useMemo(
    () => listParam(repositoryParam),
    [repositoryParam]
  );
  const stages = useMemo(() => pipeline?.stages ?? [], [pipeline]);
  const finalStageId = stages[stages.length - 1]?.stage_id ?? null;

  const rows = useMemo(
    () =>
      releases.rows.filter(
        (release) =>
          (stageFilter.length === 0 ||
            stageFilter.includes(stageValue(release))) &&
          (repositoryFilter.length === 0 ||
            repositoryFilter.includes(repositoryValue(release)))
      ),
    [releases.rows, stageFilter, repositoryFilter]
  );

  const groups = useMemo((): ReleaseGroup[] => {
    const isReleased = (release: ReleaseRead): boolean =>
      finalStageId !== null && release.current_stage?.stage_id === finalStageId;
    return [
      {
        key: 'progress' as const,
        label: 'In progress',
        rows: rows.filter((release) => !isReleased(release)),
      },
      {
        key: 'released' as const,
        label: 'Released',
        rows: rows.filter(isReleased),
      },
    ].filter((group) => group.rows.length > 0);
  }, [rows, finalStageId]);

  const visible = useMemo(
    () =>
      groups
        .filter((group) => !folded.has(group.key))
        .flatMap((group) => group.rows),
    [groups, folded]
  );

  const onActivate = useCallback(
    (index: number) => {
      const release = visible[index];
      if (release !== undefined && team !== null)
        void navigate(
          releasePath(slug ?? '', team.key_prefix, release.release_id)
        );
    },
    [visible, navigate, slug, team]
  );

  const { activeIndex, setActiveIndex, registerItem } = useListKeyboardNav({
    count: visible.length,
    onActivate,
    resetKey: `${params.toString()}:${[...folded].join(',')}:${String(rows.length)}`,
    enabled: !isCreating,
  });

  const canEdit = canWriteIssues(workspace?.role, team?.role);

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

  const setList = (field: string, values: string[]): void => {
    const next = new URLSearchParams(params);
    if (values.length === 0) next.delete(field);
    else next.set(field, values.join(','));
    setParams(next, { replace: true });
  };
  const toggleIn = (field: string, held: string[], value: string): void => {
    setList(
      field,
      held.includes(value)
        ? held.filter((row) => row !== value)
        : [...held, value]
    );
  };
  const hasFilters = stageFilter.length > 0 || repositoryFilter.length > 0;

  const stageOptions: ComboboxOption[] = [
    {
      value: DRAFT,
      label: 'Draft',
      icon: <ReleaseStageDot tone="draft" />,
    },
    ...stages.map((stage) => ({
      value: stage.stage_id,
      label: stage.name,
      icon: (
        <ReleaseStageDot
          tone={stage.stage_id === finalStageId ? 'final' : 'stage'}
        />
      ),
    })),
  ];
  const repositories = [
    ...new Set([...releases.rows.map(repositoryValue), ...repositoryFilter]),
  ].sort((left, right) =>
    left === NO_REPOSITORY
      ? 1
      : right === NO_REPOSITORY
        ? -1
        : left.localeCompare(right)
  );
  const repositoryOptions: ComboboxOption[] = repositories.map((value) => ({
    value,
    label: value === NO_REPOSITORY ? 'No repository' : value,
    icon:
      value === NO_REPOSITORY ? undefined : (
        <LuGithub aria-hidden="true" className="h-3.5 w-3.5" />
      ),
  }));

  const settingsHref = `${teamSettingsPath(slug ?? '', team.key_prefix)}#team-settings-releases`;

  const newButton = canEdit ? (
    <Button
      variant="primary"
      size="sm"
      onClick={() => {
        setIsCreating(true);
      }}
    >
      <LuPlus aria-hidden="true" />
      New release
    </Button>
  ) : undefined;

  const loading = releases.isLoading && releases.rows.length === 0;
  const starts = groups.map((_, index) =>
    groups
      .slice(0, index)
      .filter((group) => !folded.has(group.key))
      .reduce((sum, group) => sum + group.rows.length, 0)
  );

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
      flush
    >
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-4 py-1.5 lg:px-6">
        <LuListFilter
          aria-hidden="true"
          className="mr-0.5 h-3.5 w-3.5 text-text-faint"
        />
        <FilterButton
          field="Stage"
          options={stageOptions}
          selected={stageFilter}
          onSelect={(value) => {
            toggleIn('stage', stageFilter, value);
          }}
        />
        <FilterButton
          field="Repository"
          options={repositoryOptions}
          selected={repositoryFilter}
          onSelect={(value) => {
            toggleIn('repo', repositoryFilter, value);
          }}
        />
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete('stage');
              next.delete('repo');
              setParams(next, { replace: true });
            }}
          >
            <LuX aria-hidden="true" />
            Clear
          </Button>
        )}
        <Link
          to={settingsHref}
          className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs text-text-muted transition-colors duration-100 hover:bg-hover hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          <LuSettings aria-hidden="true" className="h-3.5 w-3.5" />
          Pipeline
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {releases.error !== null && releases.error !== undefined && (
          <div className="px-4 pt-3 lg:px-6">
            <ErrorAlert
              message={errorMessage(releases.error, 'Could not load releases.')}
            />
          </div>
        )}

        {loading ? (
          <SkeletonRows label="Loading releases" />
        ) : releases.rows.length === 0 ? (
          <EmptyState
            icon={<LuRocket />}
            message="No releases yet. A release is recorded each time the Standupless GitHub App sees a successful deployment to an environment in this team's pipeline, or by hand with New release, the API, the CLI or MCP."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                {newButton}
                <Link
                  to={settingsHref}
                  className="inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs text-text-muted transition-colors duration-100 hover:bg-hover hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
                >
                  <LuSettings aria-hidden="true" className="h-3.5 w-3.5" />
                  Set up the pipeline
                </Link>
              </div>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<LuListFilter />}
            message="No releases match these filters."
          />
        ) : (
          groups.map((group, groupIndex) => {
            const open = !folded.has(group.key);
            const start = starts[groupIndex] ?? 0;
            return (
              <section key={group.key} aria-label={group.label}>
                <ReleaseGroupHeader
                  group={group}
                  open={open}
                  onToggle={() => {
                    toggleFolded(group.key);
                  }}
                />
                {open && (
                  <ul>
                    {group.rows.map((release, index) => {
                      const position = start + index;
                      return (
                        <ReleaseRow
                          key={release.release_id}
                          release={release}
                          href={releasePath(
                            slug ?? '',
                            team.key_prefix,
                            release.release_id
                          )}
                          final={
                            release.current_stage?.stage_id === finalStageId
                          }
                          creator={members.find(
                            (member) => member.user_id === release.created_by
                          )}
                          isActive={position === activeIndex}
                          rowRef={registerItem(position)}
                          onPointerEnter={() => {
                            setActiveIndex(position);
                          }}
                        />
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })
        )}

        {releases.hasMore && (
          <div className="px-4 py-2 lg:px-6">
            <Button
              variant="ghost"
              size="sm"
              disabled={releases.isPaging}
              onClick={releases.loadMore}
            >
              {releases.isPaging ? 'Loading' : 'Load more'}
            </Button>
          </div>
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
            void navigate(releasePath(slug ?? '', team.key_prefix, releaseId), {
              state,
            });
          }}
        />
      )}
    </WorkspaceShell>
  );
};

export default Releases;
