/**
 * One team's triage inbox: issues filed by guests, integrations and people
 * outside the team, waiting for a member to decide what happens to them. The
 * list sits beside the selected issue's peek, so triage runs down the list
 * without leaving it, and the selection lives in the URL.
 *
 * Triage runs from the keyboard: J and K move, 1 accepts into the team's first
 * unstarted status, 2 marks as a duplicate of another issue, 3 declines with an
 * optional reason, and H snoozes until a chosen moment. A snoozed issue leaves
 * the list and the badge and comes back by itself; the Snoozed tab lists what
 * is still waiting and offers to bring one back now.
 *
 * Guests may file into triage but never work it, so a guest sees the list
 * without the actions.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
  type QueryKey,
} from '@webbpulse/api-client/react';
import {
  LuBellRing,
  LuCheck,
  LuClock,
  LuCopy,
  LuInbox,
  LuX,
} from 'react-icons/lu';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { appendIssues, listIssues } from '../../api/issues';
import {
  acceptTriage,
  declineTriage,
  duplicateTriage,
  getTriageSettings,
  listTriage,
  snoozeTriage,
} from '../../api/triage';
import IssuePeek from '../../components/issues/IssuePeek';
import { ErrorAlert } from '../../components/ui/alert';
import Button, { IconButton } from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import EmptyState from '../../components/ui/empty-state';
import Field from '../../components/ui/field';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import TeamTabs from '../../components/workspace/TeamTabs';
import TeamTitle from '../../components/workspace/TeamTitle';
import { useCursorPages } from '../../hooks/useCursorPages';
import { useShortcut } from '../../hooks/useShortcuts';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { errorMessage, m3ErrorMessage } from '../../lib/errors';
import { timestampLabel } from '../../lib/issueDisplay';
import { teamSettingsPath } from '../../lib/paths';
import {
  triageKey,
  triageSettingsKey,
  triageSummaryKey,
} from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import type { IssueRead } from '../../types/Api';
import { SNOOZE_PRESETS, snoozeLabel } from '../inbox/snooze';

/** How often the list re-reads, matching the sidebar badge so the two agree. */
const POLL_MS = 60000;

/** How many rows a page holds. */
const PAGE_SIZE = 50;

/** The URL parameter holding the selected issue. */
const SELECTED_PARAM = 'i';

/** How many duplicate candidates the search shows at once. */
const SEARCH_LIMIT = 8;

/** The most characters a decline reason keeps, matching the server. */
const REASON_MAX = 500;

/** Which slice of the inbox is showing. */
type TriageFilter = 'waiting' | 'snoozed';

/** The slices, in the order the tabs show them. */
const FILTERS: { id: TriageFilter; label: string }[] = [
  { id: 'waiting', label: 'Waiting' },
  { id: 'snoozed', label: 'Snoozed' },
];

/** Props for TriageRow. */
interface TriageRowProps {
  issue: IssueRead;
  selected: boolean;
  canWork: boolean;
  onSelect: () => void;
  onAccept: () => void;
  onDuplicate: () => void;
  onDecline: () => void;
  onSnooze: () => void;
}

/** One waiting issue: its key, title and when it was filed, with its actions. */
const TriageRow: React.FC<TriageRowProps> = ({
  issue,
  selected,
  canWork,
  onSelect,
  onAccept,
  onDuplicate,
  onDecline,
  onSnooze,
}) => {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  return (
    <li
      ref={ref}
      data-issue-id={issue.id}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'group relative flex items-start gap-2.5 border-b border-line px-3 py-2.5 transition-colors duration-100',
        selected ? 'bg-raised' : 'hover:bg-surface'
      )}
    >
      <button
        type="button"
        data-hover="parent"
        onClick={onSelect}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-xs text-left before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="flex w-full items-center gap-2">
          <span className="shrink-0 font-mono text-2xs text-text-faint">
            {issue.key}
          </span>
          <span className="truncate text-sm font-medium text-text">
            {issue.title}
          </span>
        </span>
        <span className="flex w-full items-center gap-2 text-xs text-text-muted">
          <span className="truncate">
            {issue.snoozed_until
              ? snoozeLabel(issue.snoozed_until)
              : 'Waiting for triage'}
          </span>
          <span className="ml-auto shrink-0 tabular-nums text-text-faint">
            {timestampLabel(issue.created_at)}
          </span>
        </span>
      </button>
      {canWork && (
        <span className="relative flex shrink-0 items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <IconButton
            label={`Accept ${issue.key}`}
            size="sm"
            onClick={onAccept}
          >
            <LuCheck className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            label={`Mark ${issue.key} as duplicate`}
            size="sm"
            onClick={onDuplicate}
          >
            <LuCopy className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            label={`Decline ${issue.key}`}
            size="sm"
            onClick={onDecline}
          >
            <LuX className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            label={`Snooze ${issue.key}`}
            size="sm"
            onClick={onSnooze}
          >
            <LuClock className="h-3.5 w-3.5" />
          </IconButton>
        </span>
      )}
    </li>
  );
};

/** Props for DuplicatePicker: the issue being closed and what to do on a pick. */
interface DuplicatePickerProps {
  workspaceId: string;
  issue: IssueRead;
  saving: boolean;
  onPick: (target: IssueRead) => void;
}

/** Finds the issue a waiting one duplicates, by key or title. */
const DuplicatePicker: React.FC<DuplicatePickerProps> = ({
  workspaceId,
  issue,
  saving,
  onPick,
}) => {
  const auth = useQueryAuth();
  const [search, setSearch] = useState('');
  const term = search.trim();
  const { data: found } = usePolledQuery(
    ({ signal }) =>
      listIssues(workspaceId, { q: term, limit: SEARCH_LIMIT }, signal),
    {
      intervalMs: POLL_MS,
      enabled: term !== '',
      queryKey: ['triage-duplicate-search', issue.id, term],
      auth,
    }
  );
  const candidates =
    term === ''
      ? []
      : (found?.issues ?? []).filter((row) => row.id !== issue.id);

  return (
    <div className="space-y-3">
      <Field
        id="triage-duplicate-search"
        label="Find the original issue"
        type="search"
        placeholder="Key or title"
        autoComplete="off"
        autoFocus
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
        }}
      />
      {term !== '' && (
        <ul
          aria-label="Matching issues"
          className="max-h-72 overflow-y-auto rounded-md border border-line bg-bg"
        >
          {candidates.length === 0 ? (
            <li className="px-3 py-2 text-sm text-text-muted">
              {found === null ? 'Searching' : 'No matching issues'}
            </li>
          ) : (
            candidates.map((candidate) => (
              <li
                key={candidate.id}
                className="border-b border-line last:border-b-0"
              >
                <button
                  type="button"
                  disabled={saving}
                  className="flex h-row w-full items-center gap-2.5 px-3 text-left text-sm transition-colors duration-100 hover:bg-raised disabled:opacity-50"
                  onClick={() => {
                    onPick(candidate);
                  }}
                >
                  <span className="shrink-0 font-mono text-xs text-text-faint">
                    {candidate.key}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-text">
                    {candidate.title}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
};

/** Which dialog is open, and over which issue. */
type Pending =
  | { kind: 'duplicate'; issue: IssueRead }
  | { kind: 'decline'; issue: IssueRead }
  | { kind: 'snooze'; issue: IssueRead }
  | null;

/** The triage inbox of the team named by the route's key prefix. */
export const TeamTriage: React.FC = () => {
  const { keyPrefix, slug } = useParams<{ slug: string; keyPrefix: string }>();
  const { workspace } = useWorkspace();
  const auth = useQueryAuth();
  const [params, setParams] = useSearchParams();
  const {
    team,
    workspaceId,
    isLoading: isResolving,
    notFound,
    error: teamsError,
  } = useTeam(keyPrefix);
  const [filter, setFilter] = useState<TriageFilter>('waiting');
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState('');

  const teamId = team?.id ?? '';
  const enabled = teamId !== '' && workspaceId !== '';
  const queryKey = triageKey(workspaceId, teamId, filter === 'snoozed');
  const selectedId = params.get(SELECTED_PARAM);
  const canWork =
    workspace?.role !== 'guest' && canWriteIssues(workspace?.role, team?.role);

  const { data: settings } = usePolledQuery(
    ({ signal }) => getTriageSettings(workspaceId, teamId, signal),
    {
      intervalMs: POLL_MS,
      enabled,
      queryKey: triageSettingsKey(workspaceId, teamId),
      auth,
    }
  );

  const read = useCallback(
    (cursor: string | undefined, signal?: AbortSignal) =>
      listTriage(
        workspaceId,
        {
          team_id: teamId,
          ...(filter === 'snoozed' ? { snoozed: true } : {}),
          ...(cursor === undefined ? {} : { cursor }),
          limit: PAGE_SIZE,
        },
        signal
      ).then((page) => ({ rows: page.issues, nextCursor: page.next_cursor })),
    [workspaceId, teamId, filter]
  );

  const merge = useCallback(
    (held: IssueRead[], incoming: IssueRead[]) =>
      appendIssues(held, { issues: incoming, next_cursor: null }),
    []
  );

  const { rows, error, isLoading, isPaging, hasMore, loadMore } =
    useCursorPages(read, merge, { queryKey, enabled, intervalMs: POLL_MS });

  const everyKey: QueryKey[] = [
    triageKey(workspaceId, teamId, false),
    triageKey(workspaceId, teamId, true),
    triageSummaryKey(workspaceId),
  ];

  const { mutate: accept, error: acceptError } = useMutationWithRefetch(
    (issueId: string) => acceptTriage(workspaceId, issueId),
    everyKey
  );
  const {
    mutate: decline,
    error: declineError,
    isMutating: declining,
  } = useMutationWithRefetch(
    ({ issueId, why }: { issueId: string; why: string }) =>
      declineTriage(workspaceId, issueId, why === '' ? {} : { reason: why }),
    everyKey
  );
  const {
    mutate: duplicate,
    error: duplicateError,
    isMutating: duplicating,
  } = useMutationWithRefetch(
    ({ issueId, targetId }: { issueId: string; targetId: string }) =>
      duplicateTriage(workspaceId, issueId, { duplicate_of_id: targetId }),
    everyKey
  );
  const { mutate: snooze, error: snoozeError } = useMutationWithRefetch(
    ({ issueId, until }: { issueId: string; until: string | null }) =>
      snoozeTriage(workspaceId, issueId, { until }),
    everyKey
  );

  const selected = useMemo(
    () => rows.find((row) => row.id === selectedId) ?? null,
    [rows, selectedId]
  );
  const selectedIndex = selected === null ? -1 : rows.indexOf(selected);

  const select = useCallback(
    (row: IssueRead | null) => {
      const next = new URLSearchParams(params);
      if (row === null) next.delete(SELECTED_PARAM);
      else next.set(SELECTED_PARAM, row.id);
      setParams(next, { replace: true });
    },
    [params, setParams]
  );

  const step = (delta: number): void => {
    if (rows.length === 0) return;
    const from =
      selectedIndex === -1 ? (delta > 0 ? -1 : rows.length) : selectedIndex;
    const to = Math.min(rows.length - 1, Math.max(0, from + delta));
    const row = rows[to];
    if (row !== undefined && row !== selected) select(row);
  };

  const stepPast = (row: IssueRead): void => {
    if (row.id !== selected?.id) return;
    select(rows[selectedIndex + 1] ?? rows[selectedIndex - 1] ?? null);
  };

  const acceptRow = (row: IssueRead): void => {
    stepPast(row);
    void accept(row.id)
      .then(() => {
        showToast(`${row.key} accepted.`);
      })
      .catch(() => undefined);
  };

  const declineRow = (row: IssueRead): void => {
    const why = reason.trim();
    setPending(null);
    setReason('');
    stepPast(row);
    void decline({ issueId: row.id, why })
      .then(() => {
        showToast(`${row.key} declined.`);
      })
      .catch(() => undefined);
  };

  const duplicateRow = (row: IssueRead, target: IssueRead): void => {
    setPending(null);
    stepPast(row);
    void duplicate({ issueId: row.id, targetId: target.id })
      .then(() => {
        showToast(`${row.key} marked as a duplicate of ${target.key}.`);
      })
      .catch(() => undefined);
  };

  const snoozeRow = (row: IssueRead, until: Date | null): void => {
    setPending(null);
    if (until !== null || filter === 'snoozed') stepPast(row);
    void snooze({
      issueId: row.id,
      until: until === null ? null : until.toISOString(),
    }).catch(() => undefined);
  };

  const hasRows = rows.length > 0;
  const canAct = canWork && selected !== null && pending === null;
  useShortcut({
    keys: 'j',
    label: 'Next issue',
    group: 'Triage',
    enabled: hasRows,
    handler: () => {
      step(1);
    },
  });
  useShortcut({
    keys: 'k',
    label: 'Previous issue',
    group: 'Triage',
    enabled: hasRows,
    handler: () => {
      step(-1);
    },
  });
  useShortcut({
    keys: 'escape',
    label: 'Close issue',
    group: 'Triage',
    enabled: selected !== null && pending === null,
    handler: () => {
      select(null);
    },
  });
  useShortcut({
    keys: '1',
    label: 'Accept',
    group: 'Triage',
    enabled: canAct,
    handler: () => {
      if (selected !== null) acceptRow(selected);
    },
  });
  useShortcut({
    keys: '2',
    label: 'Mark as duplicate',
    group: 'Triage',
    enabled: canAct,
    handler: (event) => {
      event?.preventDefault();
      if (selected !== null) setPending({ kind: 'duplicate', issue: selected });
    },
  });
  useShortcut({
    keys: '3',
    label: 'Decline',
    group: 'Triage',
    enabled: canAct,
    handler: (event) => {
      event?.preventDefault();
      if (selected !== null) setPending({ kind: 'decline', issue: selected });
    },
  });
  useShortcut({
    keys: 'h',
    label: 'Snooze',
    group: 'Triage',
    enabled: canAct,
    handler: () => {
      if (selected !== null) setPending({ kind: 'snooze', issue: selected });
    },
  });

  if (isResolving) {
    return (
      <WorkspaceShell title="Triage">
        {teamsError !== null && (
          <ErrorAlert
            message={errorMessage(teamsError, 'Could not load this team.')}
          />
        )}
        <Spinner label="Loading triage" />
      </WorkspaceShell>
    );
  }

  if (notFound || team === null) {
    return (
      <WorkspaceShell title="Triage">
        <EmptyState message="That team does not exist, or you are not a member of it." />
      </WorkspaceShell>
    );
  }

  const errors = [
    error === null ? null : m3ErrorMessage(error, 'Could not load triage.'),
    acceptError === null
      ? null
      : m3ErrorMessage(acceptError, 'Could not accept that issue.'),
    declineError === null
      ? null
      : m3ErrorMessage(declineError, 'Could not decline that issue.'),
    duplicateError === null
      ? null
      : m3ErrorMessage(duplicateError, 'Could not mark that as a duplicate.'),
    snoozeError === null
      ? null
      : m3ErrorMessage(snoozeError, 'Could not snooze that issue.'),
  ].filter((message): message is string => message !== null);

  const isOff = settings !== null && !settings.enabled;
  const closeDialog = (): void => {
    setPending(null);
    setReason('');
  };

  return (
    <WorkspaceShell
      title={<TeamTitle name={team.name} keyPrefix={team.key_prefix} />}
      flush
      toolbar={
        <TeamTabs
          slug={slug ?? ''}
          keyPrefix={team.key_prefix}
          current="triage"
        />
      }
      actions={
        <div
          role="group"
          aria-label="Show"
          className="flex items-center gap-0.5 rounded-md border border-line p-0.5"
        >
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={filter === option.id}
              onClick={() => {
                setFilter(option.id);
              }}
              className={cn(
                'rounded-sm px-2 py-0.5 text-xs transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-accent',
                filter === option.id
                  ? 'bg-raised text-text'
                  : 'text-text-muted hover:text-text'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      }
    >
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Triage"
          className={cn(
            'min-h-0 w-full shrink-0 flex-col overflow-y-auto border-line lg:w-[380px] lg:border-r',
            selected === null ? 'flex' : 'hidden lg:flex'
          )}
        >
          {isOff && (
            <p className="border-b border-line px-3 py-2 text-xs text-text-muted">
              Triage is off for this team, so new issues file straight in.{' '}
              <Link
                to={teamSettingsPath(slug ?? '', team.key_prefix)}
                className="text-accent hover:underline"
              >
                Team settings
              </Link>
            </p>
          )}
          {errors.length > 0 && (
            <div className="space-y-2 p-3">
              {errors.map((message) => (
                <ErrorAlert key={message} message={message} />
              ))}
            </div>
          )}
          {isLoading ? (
            <div className="p-6">
              <Spinner label="Loading triage" />
            </div>
          ) : rows.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={<LuInbox />}
                message={
                  filter === 'snoozed'
                    ? 'Nothing snoozed.'
                    : 'Nothing waiting for triage.'
                }
              />
            </div>
          ) : (
            <ul>
              {rows.map((row) => (
                <TriageRow
                  key={row.id}
                  issue={row}
                  selected={row.id === selected?.id}
                  canWork={canWork}
                  onSelect={() => {
                    select(row);
                  }}
                  onAccept={() => {
                    acceptRow(row);
                  }}
                  onDuplicate={() => {
                    setPending({ kind: 'duplicate', issue: row });
                  }}
                  onDecline={() => {
                    setPending({ kind: 'decline', issue: row });
                  }}
                  onSnooze={() => {
                    setPending({ kind: 'snooze', issue: row });
                  }}
                />
              ))}
            </ul>
          )}
          {hasMore && (
            <div className="p-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={isPaging}
                onClick={loadMore}
              >
                {isPaging ? 'Loading' : 'Load more'}
              </Button>
            </div>
          )}
        </section>
        <div
          className={cn(
            'min-h-0 min-w-0 flex-1 flex-col [&>aside]:w-full [&>aside]:border-l-0',
            selected === null ? 'hidden lg:flex' : 'flex'
          )}
        >
          {selected === null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-text-faint">
              <LuInbox aria-hidden="true" className="h-8 w-8" />
              <p>
                {rows.length === 0
                  ? 'You are all caught up.'
                  : 'Select an issue to triage it.'}
              </p>
            </div>
          ) : (
            <>
              {canWork && (
                <div
                  role="toolbar"
                  aria-label="Triage actions"
                  className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2"
                >
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      acceptRow(selected);
                    }}
                  >
                    <LuCheck className="h-3.5 w-3.5" aria-hidden="true" />
                    Accept
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setPending({ kind: 'duplicate', issue: selected });
                    }}
                  >
                    <LuCopy className="h-3.5 w-3.5" aria-hidden="true" />
                    Duplicate
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setPending({ kind: 'decline', issue: selected });
                    }}
                  >
                    <LuX className="h-3.5 w-3.5" aria-hidden="true" />
                    Decline
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setPending({ kind: 'snooze', issue: selected });
                    }}
                  >
                    <LuClock className="h-3.5 w-3.5" aria-hidden="true" />
                    Snooze
                  </Button>
                </div>
              )}
              <div className="flex min-h-0 flex-1 [&>aside]:w-full [&>aside]:border-l-0">
                <IssuePeek
                  key={selected.id}
                  issueId={selected.id}
                  onClose={() => {
                    select(null);
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      <Dialog
        open={pending?.kind === 'duplicate'}
        onClose={closeDialog}
        title="Mark as duplicate"
        description={`${pending?.issue.key ?? 'The issue'} is closed and linked to the issue you pick.`}
        size="md"
      >
        {pending?.kind === 'duplicate' && (
          <DuplicatePicker
            workspaceId={workspaceId}
            issue={pending.issue}
            saving={duplicating}
            onPick={(target) => {
              duplicateRow(pending.issue, target);
            }}
          />
        )}
      </Dialog>

      <Dialog
        open={pending?.kind === 'decline'}
        onClose={closeDialog}
        title="Decline issue"
        description={`${pending?.issue.key ?? 'The issue'} moves to the team's cancelled status.`}
        size="sm"
      >
        {pending?.kind === 'decline' && (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              declineRow(pending.issue);
            }}
          >
            <Field
              id="triage-decline-reason"
              label="Reason (optional)"
              autoComplete="off"
              autoFocus
              maxLength={REASON_MAX}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={closeDialog}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={declining}
              >
                Decline
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      <Dialog
        open={pending?.kind === 'snooze'}
        onClose={closeDialog}
        title="Snooze issue"
        description={`${pending?.issue.key ?? 'The issue'} comes back to triage at the time you pick.`}
        size="sm"
      >
        <ul className="flex flex-col gap-1">
          {pending?.kind === 'snooze' && pending.issue.snoozed_until ? (
            <li>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  snoozeRow(pending.issue, null);
                }}
              >
                <LuBellRing className="h-3.5 w-3.5" aria-hidden="true" />
                Unsnooze now
              </Button>
            </li>
          ) : null}
          {SNOOZE_PRESETS.map((preset) => (
            <li key={preset.id}>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  if (pending?.kind === 'snooze')
                    snoozeRow(pending.issue, preset.until(new Date()));
                }}
              >
                <LuClock className="h-3.5 w-3.5" aria-hidden="true" />
                {preset.label}
              </Button>
            </li>
          ))}
        </ul>
      </Dialog>
    </WorkspaceShell>
  );
};

export default TeamTriage;
