/**
 * Search across the teams a person can see: issues, projects, initiatives,
 * documents and comments, grouped by kind. The result set is capped rather
 * than paged, because the contract does not mint a cursor over an intersection
 * of posting lists, so this page offers a narrower term instead of a next page.
 *
 * The term, team, kind and status filter live in the address, so a search can
 * be shared, survives a reload and comes back on the back button. Typing
 * replaces the entry rather than pushing one per keystroke.
 *
 * An exact issue key short circuits to that issue, since typing a key is the
 * most common search and the index is not the right answer for it.
 */

import React, { useCallback, useDeferredValue, useMemo } from 'react';
import { LuFileText, LuGoal, LuMessageSquare, LuSearch } from 'react-icons/lu';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { searchAll } from '../../api/views';
import ProjectStatusGlyph from '../../components/planning/ProjectStatusGlyph';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import EmptyState from '../../components/ui/empty-state';
import Input from '../../components/ui/input';
import Label from '../../components/ui/label';
import TextLink from '../../components/ui/link';
import { SelectField } from '../../components/ui/select';
import Spinner from '../../components/ui/spinner';
import { StatusIcon } from '../../components/ui/StatusIcon';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { cn } from '../../lib/cn';
import { m3ErrorMessage } from '../../lib/errors';
import { personLabel } from '../../lib/issuePeople';
import {
  documentPath,
  initiativePath,
  issuePath,
  projectPath,
} from '../../lib/paths';
import {
  INITIATIVE_STATUS_LABELS,
  PROJECT_STATUS_LABELS,
} from '../../lib/planningDisplay';
import {
  STATUS_CATEGORY_LABELS,
  STATUS_CATEGORY_ORDER,
} from '../../lib/propertyOptions';
import { searchKey } from '../../lib/queryKeys';
import {
  hasIndexableTerm,
  isIssueKey,
  isPartialIssueKey,
} from '../../lib/searchTerms';
import type { StatusLike } from '../../lib/statusAppearance';
import type {
  MemberRead,
  SearchResultRead,
  SearchType,
  StatusCategory,
} from '../../types/Api';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { useTeams } from '../../hooks/useTeams';

/** How many hits of each kind the route is asked for, which is also what it caps at. */
const RESULT_LIMIT = 50;

/** How many hits of each kind the All tab lists before offering the kind's own tab. */
const PREVIEW_LIMIT = 5;

/** How often a search re-reads while its term is unchanged. */
const POLL_MS = 60000;

/** The tabs in the order they read, with the kind each narrows to. */
const TABS: { value: SearchType | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'issues', label: 'Issues' },
  { value: 'projects', label: 'Projects' },
  { value: 'initiatives', label: 'Initiatives' },
  { value: 'documents', label: 'Documents' },
  { value: 'comments', label: 'Comments' },
];

const KINDS = new Set<string>(TABS.map((tab) => tab.value));

const CATEGORIES = new Set<string>(STATUS_CATEGORY_ORDER);

const ROW =
  'flex h-row items-center border-b border-line px-4 transition-colors duration-100 hover:bg-surface has-[a:active]:bg-raised lg:px-6';

const ROW_LINK = 'flex min-w-0 flex-1 items-center gap-2.5 rounded-xs';

/** The status a hit carries, in the shape the glyph resolves. */
const statusOf = (hit: SearchResultRead): StatusLike | undefined =>
  hit.status_category === null || hit.status_category === undefined
    ? undefined
    : {
        id: hit.status_id,
        category: hit.status_category,
        color: hit.status_color ?? null,
        icon: hit.status_icon ?? null,
      };

/** One kind's heading, with a way into its own tab when the All tab cut it short. */
const SectionHeading: React.FC<{
  id: string;
  label: string;
  total: number;
  onShowAll: (() => void) | null;
}> = ({ id, label, total, onShowAll }) => (
  <div className="flex items-center justify-between border-b border-line px-4 py-1.5 lg:px-6">
    <h2 id={id} className="text-xs font-medium text-text-muted">
      {label}
      <span className="ml-1.5 text-text-faint tabular-nums">{total}</span>
    </h2>
    {onShowAll !== null && (
      <button
        type="button"
        onClick={onShowAll}
        className="rounded-xs text-xs text-text-faint hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
      >
        Show all {label.toLowerCase()}
      </button>
    )}
  </div>
);

/** Searches issues, projects, initiatives, documents and comments across the visible teams. */
export const Search: React.FC = () => {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const auth = useQueryAuth();
  const [params, setParams] = useSearchParams();

  const term = params.get('q') ?? '';
  const teamId = params.get('team') ?? '';
  const rawType = params.get('type') ?? '';
  const tab = (KINDS.has(rawType) ? rawType : '') as SearchType | '';
  const rawStatus = params.get('status') ?? '';
  const statusCategory = (CATEGORIES.has(rawStatus) ? rawStatus : '') as
    StatusCategory | '';

  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';

  const setParam = useCallback(
    (name: string, value: string, replace: boolean) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value === '') next.delete(name);
          else next.set(name, value);
          return next;
        },
        { replace }
      );
    },
    [setParams]
  );

  const deferred = useDeferredValue(term).trim();
  const isKey = isIssueKey(deferred);
  const isPartialKey = isPartialIssueKey(deferred);
  const indexable = hasIndexableTerm(deferred);
  const enabled =
    workspaceId !== '' &&
    deferred !== '' &&
    indexable &&
    !isKey &&
    !isPartialKey;

  const { data: teams } = useTeams();
  const members = useWorkspaceMembers(workspaceId, enabled);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) =>
      searchAll(
        workspaceId,
        deferred,
        {
          ...(teamId === '' ? {} : { team_id: teamId }),
          ...(statusCategory === '' ? {} : { status_category: statusCategory }),
          limit: RESULT_LIMIT,
        },
        signal
      ),
    {
      intervalMs: POLL_MS,
      enabled,
      queryKey: searchKey(workspaceId, deferred, teamId, '', statusCategory),
      auth,
    }
  );

  const teamNames = useMemo(
    () => new Map((teams ?? []).map((team) => [team.id, team.name])),
    [teams]
  );
  const people = useMemo(
    () => new Map<string, MemberRead>(members.map((m) => [m.user_id, m])),
    [members]
  );

  const goToKey = useCallback(() => {
    if (!isKey) return;
    void navigate(issuePath(slug, deferred.toUpperCase()));
  }, [isKey, navigate, slug, deferred]);

  const results = data?.results ?? [];
  const projects = data?.projects ?? [];
  const initiatives = data?.initiatives ?? [];
  const documents = data?.documents ?? [];
  const comments = data?.comments ?? [];

  const counts: Record<SearchType, number> = {
    issues: results.length,
    projects: projects.length,
    initiatives: initiatives.length,
    documents: documents.length,
    comments: comments.length,
  };
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

  /** Whether a kind is listed under the current tab. */
  const shows = (kind: SearchType): boolean =>
    (tab === '' || tab === kind) && counts[kind] > 0;

  /** The hits of one kind the current tab lists. */
  const visible = <T,>(rows: T[]): T[] =>
    tab === '' ? rows.slice(0, PREVIEW_LIMIT) : rows;

  /** The heading for one kind, offering its tab when the All tab cut it short. */
  const heading = (kind: SearchType, label: string) => (
    <SectionHeading
      id={`search-${kind}`}
      label={label}
      total={counts[kind]}
      onShowAll={
        tab === '' && counts[kind] > PREVIEW_LIMIT
          ? () => {
              setParam('type', kind, false);
            }
          : null
      }
    />
  );

  const showsIssueFilter = tab === '' || tab === 'issues';
  const emptyTab = tab !== '' && counts[tab] === 0;
  const capped = (Object.keys(counts) as SearchType[]).some(
    (kind) => shows(kind) && counts[kind] >= RESULT_LIMIT
  );

  return (
    <WorkspaceShell
      title="Search"
      toolbar={
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            goToKey();
          }}
        >
          <div className="relative w-72">
            <Label htmlFor="search-term" hidden>
              Search
            </Label>
            <LuSearch
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-text-faint"
            />
            <Input
              id="search-term"
              type="search"
              className="pl-8"
              placeholder="Search issues, projects, documents and comments"
              autoComplete="off"
              value={term}
              autoFocus
              onChange={(event) => {
                setParam('q', event.target.value, true);
              }}
            />
          </div>
          <SelectField
            id="search-team"
            label="Team"
            hideLabel
            className="w-44"
            value={teamId}
            onChange={(event) => {
              setParam('team', event.target.value, false);
            }}
          >
            <option value="">Every team</option>
            {(teams ?? []).map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </SelectField>
          {showsIssueFilter && (
            <SelectField
              id="search-status"
              label="Status"
              hideLabel
              className="w-40"
              value={statusCategory}
              onChange={(event) => {
                setParam('status', event.target.value, false);
              }}
            >
              <option value="">Any status</option>
              {STATUS_CATEGORY_ORDER.map((category) => (
                <option key={category} value={category}>
                  {STATUS_CATEGORY_LABELS[category]}
                </option>
              ))}
            </SelectField>
          )}
        </form>
      }
      flush
    >
      <div
        role="tablist"
        aria-label="Result type"
        className="flex flex-wrap gap-1 border-b border-line px-4 py-1.5 lg:px-6"
      >
        {TABS.map((option) => {
          const selected = tab === option.value;
          const count = option.value === '' ? total : counts[option.value];
          return (
            <button
              key={option.value || 'all'}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => {
                setParam('type', option.value, false);
              }}
              className={cn(
                'rounded-md px-2 py-1 text-sm transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
                selected
                  ? 'bg-raised text-text'
                  : 'text-text-muted hover:text-text'
              )}
            >
              {option.label}
              {data !== undefined && enabled && (
                <span className="ml-1.5 text-xs text-text-faint tabular-nums">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error !== null && (
          <div className="px-4 pt-3 lg:px-6">
            <ErrorAlert
              message={m3ErrorMessage(error, 'Could not run that search.')}
            />
          </div>
        )}

        {isKey ? (
          <p className="px-4 py-3 text-sm text-text-muted lg:px-6">
            <TextLink to={issuePath(slug, deferred.toUpperCase())}>
              Go to {deferred.toUpperCase()}
            </TextLink>
          </p>
        ) : deferred === '' ? (
          <EmptyState
            icon={<LuSearch />}
            message="Type a word to search the teams you can see."
          />
        ) : !indexable ? (
          <EmptyState message="Keep typing to search." />
        ) : isLoading ? (
          <Spinner label="Searching" />
        ) : total === 0 ? (
          <EmptyState message="Nothing matched that search." />
        ) : emptyTab ? (
          <EmptyState
            message={`No ${TABS.find((option) => option.value === tab)?.label.toLowerCase() ?? 'results'} matched that search.`}
          />
        ) : (
          <>
            {shows('issues') && (
              <section aria-labelledby="search-issues">
                {heading('issues', 'Issues')}
                <ul>
                  {visible(results).map((result) => {
                    const assignee =
                      result.assignee_id === null
                        ? undefined
                        : people.get(result.assignee_id);
                    return (
                      <li key={result.issue_id} className={ROW}>
                        <Link
                          to={issuePath(slug, result.key)}
                          data-hover="parent"
                          className={ROW_LINK}
                        >
                          <StatusIcon
                            status={statusOf(result)}
                            {...(result.status_name === null ||
                            result.status_name === undefined
                              ? {}
                              : { name: result.status_name })}
                          />
                          <span className="w-16 shrink-0 truncate font-mono text-xs text-text-faint">
                            {result.key}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">
                            {result.title}
                          </span>
                          <span className="hidden shrink-0 truncate text-xs text-text-faint sm:inline">
                            {teamNames.get(result.team_id) ?? ''}
                          </span>
                          {result.assignee_id === null ? (
                            <span
                              aria-label="Unassigned"
                              role="img"
                              className="h-4 w-4 shrink-0 rounded-full border border-dashed border-line-strong"
                            />
                          ) : (
                            <span
                              role="img"
                              aria-label={`Assigned to ${personLabel(assignee)}`}
                              title={personLabel(assignee)}
                              className="shrink-0"
                            >
                              <Avatar
                                name={personLabel(assignee)}
                                src={assignee?.avatar_url ?? null}
                                size="xs"
                              />
                            </span>
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {shows('projects') && (
              <section aria-labelledby="search-projects">
                {heading('projects', 'Projects')}
                <ul>
                  {visible(projects).map((project) => (
                    <li key={project.project_id} className={ROW}>
                      <Link
                        to={projectPath(slug, project.project_id)}
                        data-hover="parent"
                        className={ROW_LINK}
                      >
                        <ProjectStatusGlyph
                          status={project.status}
                          name={PROJECT_STATUS_LABELS[project.status]}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">
                          {project.name}
                        </span>
                        <span className="hidden shrink-0 truncate text-xs text-text-faint sm:inline">
                          {project.team_ids
                            .map((id) => teamNames.get(id))
                            .filter((name) => name !== undefined)
                            .join(', ')}
                        </span>
                        <span className="w-20 shrink-0 truncate text-right text-xs text-text-faint">
                          {PROJECT_STATUS_LABELS[project.status]}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {shows('initiatives') && (
              <section aria-labelledby="search-initiatives">
                {heading('initiatives', 'Initiatives')}
                <ul>
                  {visible(initiatives).map((initiative) => (
                    <li key={initiative.initiative_id} className={ROW}>
                      <Link
                        to={initiativePath(slug, initiative.initiative_id)}
                        data-hover="parent"
                        className={ROW_LINK}
                      >
                        <LuGoal
                          aria-hidden="true"
                          className="h-3.5 w-3.5 shrink-0 text-text-faint"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">
                          {initiative.name}
                        </span>
                        <span className="w-20 shrink-0 truncate text-right text-xs text-text-faint">
                          {INITIATIVE_STATUS_LABELS[initiative.status]}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {shows('documents') && (
              <section aria-labelledby="search-documents">
                {heading('documents', 'Documents')}
                <ul>
                  {visible(documents).map((row) => (
                    <li key={row.document_id} className={ROW}>
                      <Link
                        to={documentPath(slug, row.document_id)}
                        data-hover="parent"
                        className={ROW_LINK}
                      >
                        <LuFileText
                          aria-hidden="true"
                          className="h-3.5 w-3.5 shrink-0 text-text-faint"
                        />
                        <span className="truncate text-sm font-medium text-text">
                          {row.title}
                        </span>
                        <span className="shrink-0 truncate text-xs text-text-faint">
                          {row.parent_name}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {shows('comments') && (
              <section aria-labelledby="search-comments">
                {heading('comments', 'Comments')}
                <ul>
                  {visible(comments).map((comment) => {
                    const author = people.get(comment.author_id);
                    return (
                      <li
                        key={comment.comment_id}
                        className="flex items-start border-b border-line px-4 py-2 transition-colors duration-100 hover:bg-surface has-[a:active]:bg-raised lg:px-6"
                      >
                        <Link
                          to={`${
                            comment.document_id
                              ? documentPath(slug, comment.document_id)
                              : issuePath(slug, comment.issue_key)
                          }#comment-${comment.comment_id}`}
                          data-hover="parent"
                          className="flex min-w-0 flex-1 items-start gap-2.5 rounded-xs"
                        >
                          <LuMessageSquare
                            aria-hidden="true"
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-faint"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className="w-16 shrink-0 truncate font-mono text-xs text-text-faint">
                                {comment.document_id
                                  ? 'Doc'
                                  : comment.issue_key}
                              </span>
                              <span className="truncate text-sm font-medium text-text">
                                {comment.document_id
                                  ? (comment.document_title ?? 'Document')
                                  : comment.issue_title}
                              </span>
                            </span>
                            <span className="mt-0.5 line-clamp-2 text-xs text-text-muted">
                              {comment.snippet}
                            </span>
                          </span>
                          <span
                            role="img"
                            aria-label={`Comment by ${personLabel(author)}`}
                            title={personLabel(author)}
                            className="shrink-0"
                          >
                            <Avatar
                              name={personLabel(author)}
                              src={author?.avatar_url ?? null}
                              size="xs"
                            />
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {capped && (
              <p className="px-4 py-3 text-xs text-text-faint lg:px-6">
                Showing the first {RESULT_LIMIT} matches of each kind. Narrow
                the term to see fewer, more exact ones.
              </p>
            )}
          </>
        )}
      </div>
    </WorkspaceShell>
  );
};

export default Search;
