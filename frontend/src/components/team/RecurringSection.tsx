/**
 * A team's recurring issues: schedules that create an issue from one of its
 * templates daily, weekly on chosen weekdays or monthly, at a local time in a
 * timezone. Any team member keeps them, as in Linear.
 *
 * The next run is shown in the viewer's local time with the note that the
 * hourly sweep creates the issue within the hour after it, so the time shown
 * is never earlier than the issue can appear. A paused schedule shows no next
 * run, and one the system paused says why.
 */

import React, { useId, useMemo, useState } from 'react';
import { LuPause, LuPencil, LuPlay, LuTrash2 } from 'react-icons/lu';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  createRecurringIssue,
  deleteRecurringIssue,
  listRecurringIssues,
  updateRecurringIssue,
} from '../../api/recurring';
import { listTeamTemplates } from '../../api/templates';
import { errorMessage } from '../../lib/errors';
import { needsAnswers } from '../../lib/issueTemplates';
import { recurringKey, templatesKey } from '../../lib/queryKeys';
import { describeRule, WEEKDAY_SHORT } from '../../lib/recurringRule';
import { fullTimestamp } from '../../lib/relativeTime';
import type {
  RecurringFrequency,
  RecurringIssueCreate,
  RecurringIssueRead,
  RecurringIssueUpdate,
  RecurringPausedReason,
  TemplateRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import { Badge } from '../ui/badge';
import Button, { IconButton } from '../ui/button';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for RecurringSection: which team, and whether the caller may edit. */
export interface RecurringSectionProps {
  workspaceId: string;
  teamId: string;
  /** Whether the caller may keep the team's schedules, as a team member. */
  canEdit: boolean;
  /** A template to open the new schedule form with, from "Make recurring". */
  initialTemplateId?: string | null;
}

/** How often the list is re-read while the settings page is open. */
const POLL_MS = 60000;

const FREQUENCIES: readonly { value: RecurringFrequency; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

const MAX_INTERVAL: Record<RecurringFrequency, number> = {
  daily: 365,
  weekly: 52,
  monthly: 12,
};

const PAUSE_REASONS: Record<RecurringPausedReason, string> = {
  template_deleted: 'Template deleted',
  creator_cannot_write: 'Creator left the team',
  create_failed: 'Could not create the issue',
};

/** The form's working copy of one schedule. */
interface Draft {
  templateId: string;
  frequency: RecurringFrequency;
  interval: number;
  weekdays: number[];
  dayOfMonth: number;
  time: string;
  timezone: string;
}

const isFrequency = (value: string): value is RecurringFrequency =>
  FREQUENCIES.some((row) => row.value === value);

/** Every timezone the browser knows, for the picker's suggestions. */
const knownZones = (): string[] => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
};

/** Monday as 0, matching the API, for today in the viewer's calendar. */
const todayWeekday = (): number => (new Date().getDay() + 6) % 7;

/** A new schedule's draft: daily at 09:00 in the team's timezone. */
const newDraft = (templateId: string, timezone: string): Draft => ({
  templateId,
  frequency: 'daily',
  interval: 1,
  weekdays: [todayWeekday()],
  dayOfMonth: new Date().getDate(),
  time: '09:00',
  timezone,
});

/** The draft a saved schedule opens into. */
const draftOf = (row: RecurringIssueRead): Draft => ({
  templateId: row.template_id,
  frequency: row.frequency,
  interval: row.interval,
  weekdays: row.weekdays.length === 0 ? [todayWeekday()] : row.weekdays,
  dayOfMonth: row.day_of_month ?? new Date().getDate(),
  time: row.time,
  timezone: row.timezone,
});

/** The rule a draft sends, with only the fields its frequency reads. */
const ruleOf = (draft: Draft): RecurringIssueUpdate => ({
  template_id: draft.templateId,
  frequency: draft.frequency,
  interval: draft.interval,
  weekdays: draft.frequency === 'weekly' ? draft.weekdays : [],
  day_of_month: draft.frequency === 'monthly' ? draft.dayOfMonth : null,
  time: draft.time,
  timezone: draft.timezone,
});

/** Props for ScheduleForm. */
interface ScheduleFormProps {
  initial: Draft;
  templates: TemplateRead[];
  zones: string[];
  submitLabel: string;
  onSubmit: (draft: Draft) => Promise<unknown>;
  onCancel: () => void;
}

/** The template and rule of one schedule; Escape cancels and Enter saves. */
const ScheduleForm: React.FC<ScheduleFormProps> = ({
  initial,
  templates,
  zones,
  submitLabel,
  onSubmit,
  onCancel,
}) => {
  const baseId = useId();
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (change: Partial<Draft>): void => {
    setDraft((held) => ({ ...held, ...change }));
  };
  const valid =
    draft.templateId !== '' &&
    draft.time !== '' &&
    draft.timezone.trim() !== '' &&
    draft.interval >= 1 &&
    (draft.frequency !== 'weekly' || draft.weekdays.length > 0);

  const toggleDay = (day: number): void => {
    set({
      weekdays: draft.weekdays.includes(day)
        ? draft.weekdays.filter((held) => held !== day)
        : [...draft.weekdays, day].sort((a, b) => a - b),
    });
  };

  const rowClass =
    'flex min-h-row flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2';
  const labelClass = 'text-sm font-medium text-text';

  return (
    <form
      aria-label={submitLabel}
      className="space-y-3"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || saving) return;
        setSaving(true);
        setError(null);
        onSubmit(draft)
          .catch((failure: unknown) => {
            setError(failure);
          })
          .finally(() => {
            setSaving(false);
          });
      }}
    >
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not save that schedule.')}
        />
      )}
      <ul className="divide-y divide-line rounded-md border border-line">
        <li className={rowClass}>
          <label htmlFor={`${baseId}-template`} className={labelClass}>
            Template
          </label>
          <Select
            id={`${baseId}-template`}
            className="w-56"
            value={draft.templateId}
            autoFocus
            onChange={(event) => {
              set({ templateId: event.target.value });
            }}
          >
            <option value="" disabled>
              Choose a template
            </option>
            {templates.map((template) => (
              <option
                key={template.id}
                value={template.id}
                disabled={
                  needsAnswers(template) && template.id !== draft.templateId
                }
              >
                {needsAnswers(template)
                  ? `${template.name} (form with required questions)`
                  : template.name}
              </option>
            ))}
          </Select>
        </li>
        <li className={rowClass}>
          <label htmlFor={`${baseId}-frequency`} className={labelClass}>
            Repeats
          </label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-text-muted">Every</span>
            <Input
              id={`${baseId}-interval`}
              aria-label="Interval"
              type="number"
              min={1}
              max={MAX_INTERVAL[draft.frequency]}
              className="w-16"
              value={String(draft.interval)}
              onChange={(event) => {
                const value = Number(event.target.value);
                set({
                  interval: Number.isFinite(value) ? Math.trunc(value) : 1,
                });
              }}
            />
            <Select
              id={`${baseId}-frequency`}
              className="w-32"
              value={draft.frequency}
              onChange={(event) => {
                const value = event.target.value;
                if (isFrequency(value)) set({ frequency: value });
              }}
            >
              {FREQUENCIES.map((row) => (
                <option key={row.value} value={row.value}>
                  {row.label}
                </option>
              ))}
            </Select>
          </div>
        </li>
        {draft.frequency === 'weekly' && (
          <li className={rowClass}>
            <span id={`${baseId}-days`} className={labelClass}>
              On
            </span>
            <div
              role="group"
              aria-labelledby={`${baseId}-days`}
              className="flex flex-wrap gap-1"
            >
              {WEEKDAY_SHORT.map((name, index) => (
                <Button
                  key={name}
                  size="sm"
                  variant={
                    draft.weekdays.includes(index) ? 'primary' : 'secondary'
                  }
                  aria-pressed={draft.weekdays.includes(index)}
                  aria-label={WEEKDAY_NAMES[index]}
                  onClick={() => {
                    toggleDay(index);
                  }}
                >
                  {name}
                </Button>
              ))}
            </div>
          </li>
        )}
        {draft.frequency === 'monthly' && (
          <li className={rowClass}>
            <label htmlFor={`${baseId}-day`} className={labelClass}>
              Day of month
            </label>
            <Input
              id={`${baseId}-day`}
              type="number"
              min={1}
              max={31}
              className="w-20"
              value={String(draft.dayOfMonth)}
              onChange={(event) => {
                const value = Math.trunc(Number(event.target.value));
                set({
                  dayOfMonth: Number.isFinite(value)
                    ? Math.min(31, Math.max(1, value))
                    : 1,
                });
              }}
            />
          </li>
        )}
        <li className={rowClass}>
          <label htmlFor={`${baseId}-time`} className={labelClass}>
            Time
          </label>
          <Input
            id={`${baseId}-time`}
            type="time"
            className="w-32"
            value={draft.time}
            onChange={(event) => {
              set({ time: event.target.value });
            }}
          />
        </li>
        <li className={rowClass}>
          <label htmlFor={`${baseId}-zone`} className={labelClass}>
            Timezone
          </label>
          <Input
            id={`${baseId}-zone`}
            className="w-56"
            list={`${baseId}-zones`}
            value={draft.timezone}
            onChange={(event) => {
              set({ timezone: event.target.value });
            }}
          />
          <datalist id={`${baseId}-zones`}>
            {zones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </li>
      </ul>
      {draft.frequency === 'monthly' && draft.dayOfMonth > 28 && (
        <p className="text-xs text-text-muted">
          In a month without day {String(draft.dayOfMonth)} it runs on the last
          day.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          type="submit"
          variant="primary"
          disabled={!valid || saving}
        >
          {saving ? 'Saving' : submitLabel}
        </Button>
      </div>
    </form>
  );
};

/** Lists and edits a team's recurring issues. */
export const RecurringSection: React.FC<RecurringSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
  initialTemplateId = null,
}) => {
  const auth = useQueryAuth();
  const zones = useMemo(knownZones, []);
  const keys = [recurringKey(teamId)];
  const [editing, setEditing] = useState<string | null>(
    canEdit && initialTemplateId !== null ? 'new' : null
  );
  const [confirming, setConfirming] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listRecurringIssues(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey: recurringKey(teamId), auth }
  );
  const { data: templateData } = usePolledQuery(
    ({ signal }) => listTeamTemplates(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey: templatesKey(teamId), auth }
  );

  const { mutate: create } = useMutationWithRefetch(
    (body: RecurringIssueCreate) =>
      createRecurringIssue(workspaceId, teamId, body),
    keys
  );
  const { mutate: update } = useMutationWithRefetch(
    (row: RecurringIssueRead, body: RecurringIssueUpdate) =>
      updateRecurringIssue(workspaceId, teamId, row.id, body),
    keys
  );
  const { mutate: remove } = useMutationWithRefetch(
    (row: RecurringIssueRead) =>
      deleteRecurringIssue(workspaceId, teamId, row.id),
    keys
  );

  const rows = data?.recurring_issues ?? [];
  const templates = templateData?.templates ?? [];
  const schedulable = templates.filter((template) => !needsAnswers(template));
  const defaultZone = data?.default_timezone ?? 'UTC';

  const run = (write: Promise<unknown>): void => {
    setActionError(null);
    write.catch((failure: unknown) => {
      setActionError(failure);
    });
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Recurring issues</h3>
        <p className="text-sm text-text-muted">
          Create an issue from a template on a schedule. Each issue is created
          within the hour after its run time, and a missed run is made up once.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the recurring issues.')}
        />
      )}
      {actionError !== null && (
        <ErrorAlert
          message={errorMessage(
            actionError,
            'Could not change that recurring issue.'
          )}
        />
      )}

      {isLoading || data === null ? (
        error === null ? (
          <Spinner label="Loading recurring issues" />
        ) : null
      ) : (
        <div className="space-y-3">
          {rows.length === 0 && editing !== 'new' && (
            <p className="text-sm text-text-muted">
              No recurring issues yet.
              {canEdit ? ' Add one, or use Make recurring on a template.' : ''}
            </p>
          )}

          {rows.length > 0 && (
            <ul
              aria-label="Recurring issues"
              className="divide-y divide-line rounded-md border border-line"
            >
              {rows.map((row) => {
                const name = row.template_name ?? 'Deleted template';
                if (editing === row.id) {
                  return (
                    <li key={row.id} className="p-3">
                      <ScheduleForm
                        initial={draftOf(row)}
                        templates={templates}
                        zones={zones}
                        submitLabel="Save schedule"
                        onCancel={() => {
                          setEditing(null);
                        }}
                        onSubmit={(draft) =>
                          update(row, ruleOf(draft)).then(() => {
                            setEditing(null);
                          })
                        }
                      />
                    </li>
                  );
                }
                return (
                  <li
                    key={row.id}
                    className="flex min-h-row items-center gap-3 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 truncate text-sm text-text">
                        <span className="truncate">{name}</span>
                        {row.paused && (
                          <Badge
                            tone={
                              row.paused_reason === null ? 'neutral' : 'warning'
                            }
                          >
                            {row.paused_reason === null
                              ? 'Paused'
                              : `Paused: ${PAUSE_REASONS[row.paused_reason]}`}
                          </Badge>
                        )}
                      </p>
                      <p className="truncate text-xs text-text-muted">
                        {describeRule(row)}
                      </p>
                      <p className="truncate text-xs text-text-faint">
                        {row.next_run_at === null ? (
                          'No next run while paused'
                        ) : (
                          <span
                            title={row.upcoming_runs
                              .map((value) => fullTimestamp(value))
                              .join('\n')}
                          >
                            Next{' '}
                            <time dateTime={row.next_run_at}>
                              {fullTimestamp(row.next_run_at)}
                            </time>
                            , created within the hour after
                          </span>
                        )}
                        {row.last_issue_key !== null &&
                          ` · Last ${row.last_issue_key}`}
                      </p>
                    </div>
                    {canEdit &&
                      (confirming === row.id ? (
                        <div
                          role="alertdialog"
                          aria-label={`Delete the ${name} schedule?`}
                          className="flex items-center gap-2"
                        >
                          <span className="text-xs text-text-muted">
                            Delete? Issues it created stay.
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setConfirming(null);
                            }}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => {
                              setConfirming(null);
                              run(remove(row));
                            }}
                          >
                            Delete
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-0.5">
                          <IconButton
                            size="sm"
                            label={
                              row.paused ? `Resume ${name}` : `Pause ${name}`
                            }
                            onClick={() => {
                              run(update(row, { paused: !row.paused }));
                            }}
                          >
                            {row.paused ? (
                              <LuPlay className="h-3.5 w-3.5" />
                            ) : (
                              <LuPause className="h-3.5 w-3.5" />
                            )}
                          </IconButton>
                          <IconButton
                            size="sm"
                            label={`Edit ${name} schedule`}
                            onClick={() => {
                              setEditing(row.id);
                            }}
                          >
                            <LuPencil className="h-3.5 w-3.5" />
                          </IconButton>
                          <IconButton
                            size="sm"
                            label={`Delete ${name} schedule`}
                            onClick={() => {
                              setConfirming(row.id);
                            }}
                          >
                            <LuTrash2 className="h-3.5 w-3.5" />
                          </IconButton>
                        </div>
                      ))}
                  </li>
                );
              })}
            </ul>
          )}

          {canEdit &&
            (editing === 'new' ? (
              <ScheduleForm
                initial={newDraft(
                  initialTemplateId ?? schedulable[0]?.id ?? '',
                  defaultZone
                )}
                templates={templates}
                zones={zones}
                submitLabel="Create schedule"
                onCancel={() => {
                  setEditing(null);
                }}
                onSubmit={(draft) =>
                  create({
                    ...ruleOf(draft),
                    template_id: draft.templateId,
                    frequency: draft.frequency,
                  }).then(() => {
                    setEditing(null);
                  })
                }
              />
            ) : (
              <Button
                size="sm"
                disabled={schedulable.length === 0}
                title={
                  templates.length === 0
                    ? 'Add a template first'
                    : schedulable.length === 0
                      ? 'A form with required questions cannot be scheduled'
                      : undefined
                }
                onClick={() => {
                  setEditing('new');
                }}
              >
                New recurring issue
              </Button>
            ))}
        </div>
      )}
    </section>
  );
};

export default RecurringSection;
