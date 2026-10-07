/**
 * One team's async standup: what each person finished, started, commented on
 * and has blocked or due, over the window that ends at the team's send time on
 * the chosen date. The digest is built from the product's own activity, so the
 * page only picks a date and a window shape and renders what comes back.
 *
 * The date lives in the address, so a digest can be linked. With no date the
 * page shows the next digest, which is also the one a note is written for.
 */

import React, { useCallback, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
  type QueryKey,
} from '@webbpulse/api-client/react';
import { LuChevronLeft, LuChevronRight, LuCoffee } from 'react-icons/lu';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  deleteStandupNote,
  getStandup,
  getStandupNote,
  getStandupSettings,
  putStandupNote,
} from '../../api/standup';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import Badge from '../../components/ui/badge';
import Button, { IconButton } from '../../components/ui/button';
import EmptyState from '../../components/ui/empty-state';
import { Input, Textarea } from '../../components/ui/input';
import { Select } from '../../components/ui/select';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import TeamTabs from '../../components/workspace/TeamTabs';
import TeamTitle from '../../components/workspace/TeamTitle';
import { useTeam } from '../../hooks/useTeam';
import { errorMessage } from '../../lib/errors';
import { issuePath, projectPath } from '../../lib/paths';
import { healthLabel } from '../../lib/projectLook';
import {
  DATE_PATTERN,
  STANDUP_SECTIONS,
  byProject,
  hasLines,
  shiftDigestDate,
} from '../../lib/standup';
import { showToast } from '../../lib/toast';
import type {
  DigestCadence,
  StandupItem,
  StandupPerson,
  StandupProjectUpdate,
} from '../../types/Api';

/** How often the digest is re-read while the page is open. */
const POLL_MS = 60000;

/** The longest note the server accepts. */
const MAX_NOTE_LENGTH = 2000;

/** A window edge as the team reads it, in the team's own timezone. */
const formatEdge = (iso: string, timeZone: string): string => {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  };
  try {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(
      new Date(iso)
    );
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(new Date(iso));
  }
};

/** Props for PersonBlock: one person's lines and where links point. */
interface PersonBlockProps {
  person: StandupPerson;
  slug: string;
  keyPrefix: string;
}

const ItemLine: React.FC<{ line: StandupItem; slug: string }> = ({
  line,
  slug,
}) => (
  <li className="flex min-w-0 items-center gap-2 text-sm">
    <Link
      to={issuePath(slug, line.key)}
      className="shrink-0 font-mono text-xs text-text-muted hover:text-text"
    >
      {line.key}
    </Link>
    <Link
      to={issuePath(slug, line.key)}
      className="min-w-0 truncate text-text hover:underline"
    >
      {line.title}
    </Link>
    {line.count > 1 && (
      <span className="shrink-0 text-xs text-text-faint tabular-nums">
        {String(line.count)} comments
      </span>
    )}
    {line.due_date !== null && (
      <span className="shrink-0 text-xs text-text-faint">
        due {line.due_date}
      </span>
    )}
  </li>
);

const UpdateLine: React.FC<{
  update: StandupProjectUpdate;
  slug: string;
  keyPrefix: string;
}> = ({ update, slug, keyPrefix }) => (
  <li className="flex min-w-0 items-center gap-2 text-sm">
    <Link
      to={projectPath(slug, update.project_id, keyPrefix)}
      className="min-w-0 truncate text-text hover:underline"
    >
      {update.project_name}
    </Link>
    <Badge
      tone={
        update.health === 'on_track'
          ? 'success'
          : update.health === 'at_risk'
            ? 'warning'
            : 'danger'
      }
    >
      {healthLabel(update.health)}
    </Badge>
  </li>
);

/** One person's block: their note, then each section grouped by project. */
const PersonBlock: React.FC<PersonBlockProps> = ({
  person,
  slug,
  keyPrefix,
}) => {
  const name = person.display_name || 'Unknown member';
  return (
    <li className="space-y-3 rounded-md border border-line p-4">
      <div className="flex items-center gap-2">
        <Avatar name={name} size="md" />
        <h3 className="text-sm font-semibold text-text">{name}</h3>
      </div>
      {person.note !== null && person.note !== '' && (
        <p className="text-sm whitespace-pre-wrap text-text-muted italic">
          {person.note}
        </p>
      )}
      {STANDUP_SECTIONS.filter(
        (section) => person[section.field].length > 0
      ).map((section) => (
        <div key={section.field} className="space-y-1">
          <h4 className="text-xs font-medium text-text-faint">
            {section.title}
          </h4>
          {byProject(person[section.field]).map((group) => (
            <div key={group.projectId ?? ''} className="space-y-1">
              {group.projectId !== null && (
                <Link
                  to={projectPath(slug, group.projectId, keyPrefix)}
                  className="block text-xs text-text-muted hover:text-text"
                >
                  {group.name ?? 'Project'}
                </Link>
              )}
              <ul
                className={
                  group.projectId === null ? 'space-y-1' : 'space-y-1 pl-3'
                }
              >
                {group.lines.map((line) => (
                  <ItemLine key={line.issue_id} line={line} slug={slug} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
      {person.project_updates.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-text-faint">
            Project updates
          </h4>
          <ul className="space-y-1">
            {person.project_updates.map((update) => (
              <UpdateLine
                key={update.update_id}
                update={update}
                slug={slug}
                keyPrefix={keyPrefix}
              />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
};

/** Props for NoteComposer: which team and digest date the note is for. */
interface NoteComposerProps {
  workspaceId: string;
  teamId: string;
  date: string;
  onSaved: () => Promise<unknown>;
}

/** The caller's own note for one upcoming digest. */
const NoteComposer: React.FC<NoteComposerProps> = ({
  workspaceId,
  teamId,
  date,
  onSaved,
}) => {
  const auth = useQueryAuth();
  const queryKey: QueryKey = ['standup-note', workspaceId, teamId, date];
  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      getStandupNote(workspaceId, teamId, date, signal),
    [workspaceId, teamId, date]
  );
  const { data, error } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    queryKey,
    auth,
  });
  const [edit, setEdit] = useState<string | null>(null);
  const saved = data?.body ?? '';
  const draft = edit ?? saved;

  const {
    mutate: save,
    isMutating: saving,
    error: saveError,
  } = useMutationWithRefetch(
    (body: string) =>
      body === ''
        ? deleteStandupNote(workspaceId, teamId, date)
        : putStandupNote(workspaceId, teamId, { body, date }),
    [queryKey]
  );

  const trimmed = draft.trim();
  const onSave = async (): Promise<void> => {
    if (trimmed === saved) return;
    try {
      await save(trimmed);
      await onSaved();
      setEdit(null);
      showToast(trimmed === '' ? 'Note removed.' : 'Note saved.');
    } catch {
      return;
    }
  };

  const onRemove = async (): Promise<void> => {
    try {
      await save('');
      await onSaved();
      setEdit(null);
      showToast('Note removed.');
    } catch {
      return;
    }
  };

  return (
    <section className="space-y-2 rounded-md border border-line p-4">
      <label
        htmlFor="standup-note"
        className="block text-sm font-medium text-text"
      >
        Your note for {date}
      </label>
      <p className="text-xs text-text-muted">
        Anything the activity does not show, such as a plan for the day or a
        question for the team. It appears under your name in this digest.
      </p>
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load your note.')}
        />
      )}
      {saveError !== null && (
        <ErrorAlert
          message={errorMessage(saveError, 'Could not save your note.')}
        />
      )}
      <Textarea
        id="standup-note"
        value={draft}
        maxLength={MAX_NOTE_LENGTH}
        placeholder="Add a note"
        onChange={(event) => {
          setEdit(event.target.value);
        }}
      />
      <div className="flex justify-end gap-2">
        {saved !== '' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => {
              void onRemove();
            }}
          >
            Remove
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          disabled={saving || trimmed === saved}
          onClick={() => {
            void onSave();
          }}
        >
          Save note
        </Button>
      </div>
    </section>
  );
};

/** The standup digest of the team named by the route's key prefix. */
export const Standup: React.FC = () => {
  const { keyPrefix, slug } = useParams<{ slug: string; keyPrefix: string }>();
  const auth = useQueryAuth();
  const [params, setParams] = useSearchParams();
  const {
    team,
    workspaceId,
    isLoading: isResolving,
    notFound,
    error: teamsError,
  } = useTeam(keyPrefix);

  const rawDate = params.get('date');
  const date = rawDate !== null && DATE_PATTERN.test(rawDate) ? rawDate : '';
  const rawCadence = params.get('cadence');
  const cadence: DigestCadence | undefined =
    rawCadence === 'daily' || rawCadence === 'weekly' ? rawCadence : undefined;

  const teamId = team?.id ?? '';
  const queryKey: QueryKey = [
    'standup',
    workspaceId,
    teamId,
    date,
    cadence ?? '',
  ];

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      getStandup(
        workspaceId,
        teamId,
        {
          ...(date === '' ? {} : { date }),
          ...(cadence === undefined ? {} : { cadence }),
        },
        signal
      ),
    [workspaceId, teamId, date, cadence]
  );
  const { data, error, isLoading, refetch } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: teamId !== '',
    queryKey,
    auth,
  });

  const readSettings = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      getStandupSettings(workspaceId, teamId, signal),
    [workspaceId, teamId]
  );
  const { data: settings } = usePolledQuery(readSettings, {
    intervalMs: POLL_MS,
    enabled: teamId !== '',
    queryKey: ['standup-settings', workspaceId, teamId],
    auth,
  });

  const update = (next: { date?: string; cadence?: DigestCadence }): void => {
    const out = new URLSearchParams(params);
    if (next.date !== undefined) {
      if (next.date === '') out.delete('date');
      else out.set('date', next.date);
    }
    if (next.cadence !== undefined) out.set('cadence', next.cadence);
    setParams(out, { replace: true });
  };

  if (isResolving) {
    return (
      <WorkspaceShell title="Standup">
        {teamsError !== null && (
          <ErrorAlert
            message={errorMessage(teamsError, 'Could not load this team.')}
          />
        )}
        <Spinner label="Loading the standup" />
      </WorkspaceShell>
    );
  }

  if (notFound || team === null) {
    return (
      <WorkspaceShell title="Standup">
        <EmptyState message="That team does not exist, or you are not a member of it." />
      </WorkspaceShell>
    );
  }

  const shape: DigestCadence = cadence ?? data?.cadence ?? 'daily';
  const shownDate = data?.date ?? date;
  const people = (data?.people ?? []).filter(hasLines);
  const nextDate = settings?.next_digest_date ?? null;
  const canNote =
    nextDate !== null && shownDate !== '' && shownDate >= nextDate;

  return (
    <WorkspaceShell
      title={<TeamTitle name={team.name} keyPrefix={team.key_prefix} />}
      toolbar={
        <TeamTabs
          slug={slug ?? ''}
          keyPrefix={team.key_prefix}
          current="standup"
        />
      }
      actions={
        <div className="flex items-center gap-1">
          <IconButton
            label="Previous digest"
            disabled={shownDate === ''}
            onClick={() => {
              update({ date: shiftDigestDate(shownDate, -1, shape) });
            }}
          >
            <LuChevronLeft aria-hidden="true" />
          </IconButton>
          <Input
            type="date"
            aria-label="Digest date"
            className="w-36"
            value={shownDate}
            onChange={(event) => {
              update({ date: event.target.value });
            }}
          />
          <IconButton
            label="Next digest"
            disabled={shownDate === ''}
            onClick={() => {
              update({ date: shiftDigestDate(shownDate, 1, shape) });
            }}
          >
            <LuChevronRight aria-hidden="true" />
          </IconButton>
          <Button
            variant="ghost"
            size="sm"
            disabled={date === ''}
            onClick={() => {
              update({ date: '' });
            }}
          >
            Next
          </Button>
          <Select
            aria-label="Digest window"
            className="w-28"
            value={shape}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'daily' || value === 'weekly') {
                update({ cadence: value });
              }
            }}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </Select>
        </div>
      }
    >
      <div className="space-y-6">
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load the standup.')}
          />
        )}

        {data !== null && (
          <p className="text-sm text-text-muted">
            {formatEdge(data.window_start, data.timezone)} to{' '}
            {formatEdge(data.window_end, data.timezone)} ({data.timezone})
            {settings !== null && settings.cadence === 'off'
              ? '. Scheduled digests are off for this team.'
              : ''}
          </p>
        )}

        {canNote && (
          <NoteComposer
            workspaceId={workspaceId}
            teamId={teamId}
            date={shownDate}
            onSaved={refetch}
          />
        )}

        {isLoading && data === null ? (
          <Spinner label="Loading the standup" />
        ) : people.length === 0 ? (
          <EmptyState
            icon={<LuCoffee />}
            message="Nothing happened in this window."
          />
        ) : (
          <ul className="space-y-3">
            {people.map((person) => (
              <PersonBlock
                key={person.user_id || 'unassigned'}
                person={person}
                slug={slug ?? ''}
                keyPrefix={team.key_prefix}
              />
            ))}
          </ul>
        )}
      </div>
    </WorkspaceShell>
  );
};

export default Standup;
