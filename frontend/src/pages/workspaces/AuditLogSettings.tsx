/**
 * The workspace audit log page. Only an owner or admin may read the log, the
 * same as the server allows, so anyone else is told so rather than shown a list
 * that would answer 403. A plan without the audit log still records events, so
 * the page points at the plans instead of showing an empty log that looks quiet.
 */

import React, { useCallback, useId, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import {
  exportAuditLogCsv,
  listAuditLog,
  listMembers,
} from '../../api/workspaces';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import Input from '../../components/ui/input';
import Label from '../../components/ui/label';
import TextLink from '../../components/ui/link';
import RelativeTime from '../../components/ui/relative-time';
import { SelectField } from '../../components/ui/select';
import Spinner from '../../components/ui/spinner';
import { useCursorPages, type CursorPage } from '../../hooks/useCursorPages';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers } from '../../lib/capabilities';
import { downloadText, todayStamp } from '../../lib/download';
import { errorMessage } from '../../lib/errors';
import { membersKey, workspaceAuditLogKey } from '../../lib/queryKeys';
import type {
  AuditEventRead,
  AuditEventType,
  AuditLogFilters,
  WorkspaceRead,
} from '../../types/Api';

/** How often the first page is re-read while the tab is open. */
const POLL_MS = 60000;

/** How often the member list behind the actor filter is re-read. */
const MEMBERS_POLL_MS = 300000;

/** The actors that are not members: the platform itself and the billing provider. */
const NON_MEMBER_ACTORS: { id: string; label: string }[] = [
  { id: 'system', label: 'Standupless' },
  { id: 'stripe', label: 'Stripe billing' },
];

/** The labels for the clients a change can come through. */
const SOURCE_LABELS: Record<string, string> = {
  web: 'Web',
  api: 'API',
  cli: 'CLI',
  mcp: 'MCP',
  system: 'System',
};

/** The start of a local calendar day as an ISO moment, or undefined when unset. */
const dayStart = (day: string): string | undefined => {
  if (day === '') return undefined;
  const moment = new Date(`${day}T00:00:00`);
  return Number.isNaN(moment.getTime()) ? undefined : moment.toISOString();
};

/** The start of the local day after `day`, so an end date includes the whole day. */
const dayAfter = (day: string): string | undefined => {
  if (day === '') return undefined;
  const moment = new Date(`${day}T00:00:00`);
  if (Number.isNaN(moment.getTime())) return undefined;
  moment.setDate(moment.getDate() + 1);
  return moment.toISOString();
};

/** A stored value as short readable text. */
const show = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return 'none';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

/** The changed fields of one event as `field: before to after` lines. */
const changeLines = (row: AuditEventRead): string[] => {
  const before = row.before ?? {};
  const after = row.after ?? {};
  const keys = Array.from(
    new Set([...Object.keys(before), ...Object.keys(after)])
  );
  return keys.map((key) => {
    if (row.before === null || row.before === undefined) {
      return `${key}: ${show(after[key])}`;
    }
    if (row.after === null || row.after === undefined) {
      return `${key}: ${show(before[key])}`;
    }
    return `${key}: ${show(before[key])} to ${show(after[key])}`;
  });
};

/** Drops rows a later page repeats, keeping the first copy of each. */
const mergeRows = (
  held: AuditEventRead[],
  incoming: AuditEventRead[]
): AuditEventRead[] => {
  const seen = new Set(held.map((row) => row.audit_id));
  return [...held, ...incoming.filter((row) => !seen.has(row.audit_id))];
};

/** Who did it, by display name where the server knows one. */
const actorLabel = (row: AuditEventRead): string => {
  if (row.actor_name) return row.actor_name;
  const known = NON_MEMBER_ACTORS.find((actor) => actor.id === row.actor_id);
  if (known !== undefined) return known.label;
  if (row.actor_kind === 'service') return 'Connected app';
  return row.actor_id;
};

/** One audit log entry as a list row. */
const AuditRow: React.FC<{ row: AuditEventRead }> = ({ row }) => {
  const changes = changeLines(row);
  const meta = [SOURCE_LABELS[row.source] ?? row.source];
  if (row.ip) meta.push(row.ip);
  return (
    <li className="space-y-1 px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 text-sm text-text">
          <span className="font-medium">{actorLabel(row)}</span>{' '}
          <span className="text-text-muted">{row.event_label}</span>
          {row.target_label ? (
            <>
              {' '}
              <span className="font-medium">{row.target_label}</span>
            </>
          ) : null}
        </p>
        <span className="shrink-0 text-xs text-text-faint">
          <RelativeTime value={row.created_at} />
        </span>
      </div>
      {changes.length > 0 && (
        <ul className="space-y-0.5">
          {changes.map((line) => (
            <li key={line} className="font-mono text-xs text-text-muted">
              {line}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-text-faint">{meta.join(' · ')}</p>
    </li>
  );
};

/** The audit log with its filters, for a workspace owner or admin. */
const AuditLogSection: React.FC<{ workspace: WorkspaceRead }> = ({
  workspace,
}) => {
  const auth = useQueryAuth();
  const idPrefix = useId();
  const [actorId, setActorId] = useState('');
  const [event, setEvent] = useState('');
  const [sinceDay, setSinceDay] = useState('');
  const [untilDay, setUntilDay] = useState('');
  const [available, setAvailable] = useState(true);
  const [eventTypes, setEventTypes] = useState<AuditEventType[]>([]);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);

  const filters = useMemo((): AuditLogFilters => {
    const since = dayStart(sinceDay);
    const until = dayAfter(untilDay);
    return {
      ...(actorId ? { actor_id: actorId } : {}),
      ...(event ? { event } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
    };
  }, [actorId, event, sinceDay, untilDay]);

  const { data: members } = usePolledQuery(
    ({ signal }) => listMembers(workspace.id, signal),
    {
      intervalMs: MEMBERS_POLL_MS,
      queryKey: membersKey(workspace.id),
      auth,
    }
  );

  const read = useCallback(
    async (
      cursor: string | undefined,
      signal?: AbortSignal
    ): Promise<CursorPage<AuditEventRead>> => {
      const page = await listAuditLog(workspace.id, filters, cursor, signal);
      setAvailable(page.available);
      if (page.event_types.length > 0) setEventTypes(page.event_types);
      return { rows: page.events, nextCursor: page.next_cursor ?? null };
    },
    [workspace.id, filters]
  );

  const { rows, error, isLoading, isPaging, hasMore, loadMore } =
    useCursorPages(read, mergeRows, {
      queryKey: workspaceAuditLogKey(workspace.id, filters),
      enabled: true,
      intervalMs: POLL_MS,
    });

  const download = async (): Promise<void> => {
    setExporting(true);
    setExportError(null);
    try {
      const csv = await exportAuditLogCsv(workspace.id, filters);
      downloadText(csv, `audit-log-${todayStamp()}.csv`);
    } catch (caught) {
      setExportError(caught);
    } finally {
      setExporting(false);
    }
  };

  const filtered = Object.keys(filters).length > 0;
  const clear = (): void => {
    setActorId('');
    setEvent('');
    setSinceDay('');
    setUntilDay('');
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Audit log</h2>
          <p className="text-sm text-text-muted">
            Security and admin changes in {workspace.name}: members, invites,
            sign-in policy, API keys, connected apps, exports, settings and
            plan. Entries are kept for a year.
          </p>
        </div>
        {available && (
          <Button
            variant="secondary"
            size="sm"
            disabled={exporting}
            onClick={() => {
              void download();
            }}
          >
            {exporting ? 'Exporting' : 'Export CSV'}
          </Button>
        )}
      </div>

      {!available ? (
        <EmptyState
          message="The audit log is available on the Business plan. Events are already being recorded, so upgrading shows the past year."
          action={
            <TextLink to={`/w/${workspace.slug}/settings/billing`}>
              View plans
            </TextLink>
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <SelectField
              id={`${idPrefix}-actor`}
              label="Actor"
              value={actorId}
              onChange={(change) => {
                setActorId(change.target.value);
              }}
            >
              <option value="">Anyone</option>
              {(members ?? []).map((member) => (
                <option key={member.user_id} value={member.user_id}>
                  {member.display_name || member.email}
                </option>
              ))}
              {NON_MEMBER_ACTORS.map((actor) => (
                <option key={actor.id} value={actor.id}>
                  {actor.label}
                </option>
              ))}
            </SelectField>
            <SelectField
              id={`${idPrefix}-event`}
              label="Event"
              value={event}
              onChange={(change) => {
                setEvent(change.target.value);
              }}
            >
              <option value="">Any event</option>
              {eventTypes.map((type) => (
                <option key={type.key} value={type.key}>
                  {type.label}
                </option>
              ))}
            </SelectField>
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-since`}>From</Label>
              <Input
                id={`${idPrefix}-since`}
                type="date"
                value={sinceDay}
                max={untilDay || undefined}
                onChange={(change) => {
                  setSinceDay(change.target.value);
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-until`}>To</Label>
              <Input
                id={`${idPrefix}-until`}
                type="date"
                value={untilDay}
                min={sinceDay || undefined}
                onChange={(change) => {
                  setUntilDay(change.target.value);
                }}
              />
            </div>
            {filtered && (
              <Button variant="ghost" size="sm" onClick={clear}>
                Clear filters
              </Button>
            )}
          </div>

          {error !== null && (
            <ErrorAlert
              message={errorMessage(error, 'Could not load the audit log.')}
            />
          )}
          {exportError !== null && (
            <ErrorAlert
              message={errorMessage(
                exportError,
                'Could not export the audit log.'
              )}
            />
          )}

          {isLoading && rows.length === 0 ? (
            <Spinner label="Loading the audit log" />
          ) : rows.length === 0 ? (
            <EmptyState
              message={
                filtered
                  ? 'No events match these filters.'
                  : 'No events have been recorded yet.'
              }
            />
          ) : (
            <ul
              aria-label="Audit events"
              className="divide-y divide-line rounded-md border border-line"
            >
              {rows.map((row) => (
                <AuditRow key={row.audit_id} row={row} />
              ))}
            </ul>
          )}

          {hasMore && (
            <Button
              variant="secondary"
              size="sm"
              disabled={isPaging}
              onClick={loadMore}
            >
              {isPaging ? 'Loading' : 'Load more'}
            </Button>
          )}
        </>
      )}
    </section>
  );
};

/** Renders the workspace audit log for an admin. */
const AuditLogSettings: React.FC = () => {
  const { workspace } = useWorkspace();

  return (
    <WorkspaceShell
      title="Settings"
      toolbar={
        workspace === null ? undefined : <SettingsNav workspace={workspace} />
      }
    >
      {workspace !== null && (
        <div className="max-w-3xl space-y-8">
          {canManageMembers(workspace.role) ? (
            <AuditLogSection workspace={workspace} />
          ) : (
            <p className="text-sm text-text-muted">
              Only workspace owners and admins can read the audit log.
            </p>
          )}
        </div>
      )}
    </WorkspaceShell>
  );
};

export default AuditLogSettings;
