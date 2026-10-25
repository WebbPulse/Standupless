/**
 * A team's SLA rules: a switch that turns them on, and per priority how long
 * an issue may stay open before it breaches. A "Start timer" select picks
 * whether the timer starts when an issue leaves triage or counts from when it
 * was created, triage included; a new choice applies from each issue's next
 * move and leaves running timers alone. A "Count time" select picks whether
 * the hours run around the clock or on business days only, skipping Saturdays
 * and Sundays in the team's timezone; switching moves open timers onto the
 * new clock at once, each keeping its start.
 *
 * Every control is one choice, so each saves as soon as it is picked rather
 * than through a draft. A rule is stamped onto an issue when its SLA starts,
 * so a change only reaches SLAs that start after it, which the hint says.
 * SLAs need the Business plan, so on a lower plan the rules are read only, the
 * switch only turns off, and a note links to the plans.
 *
 * Below the hours sits the paused set: a checkbox per open status, such as On
 * Staging, whose time does not count toward a breach. Ticking one saves the
 * whole set at once, and issues already in that status pause or resume then.
 */

import React, { useId } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
  type QueryKey,
} from '@webbpulse/api-client/react';
import {
  getSlaSettings,
  listStatuses,
  updateSlaSettings,
} from '../../api/teams';
import type {
  SlaCalendar,
  SlaSettingsRead,
  SlaSettingsUpdate,
  SlaStartMode,
  StatusCategory,
} from '../../types/Api';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { PRIORITY_LABELS } from '../../lib/issueDisplay';
import { SLA_HOUR_CHOICES, SLA_PRIORITIES, slaHoursLabel } from '../../lib/sla';
import { showToast } from '../../lib/toast';
import { ErrorAlert } from '../ui/alert';
import { Checkbox } from '../ui/checkbox';
import { Select } from '../ui/select';
import Spinner from '../ui/spinner';
import StatusIcon from '../ui/StatusIcon';
import PlanRequiredNote from './PlanRequiredNote';

/** Props for SlaSection: which team, and whether the caller may edit. */
export interface SlaSectionProps {
  workspaceId: string;
  teamId: string;
  /** Whether the caller administers the team. */
  canEdit: boolean;
  /** Whether the workspace's plan includes SLAs; true when unknown. */
  planIncluded?: boolean;
  /** The workspace slug, for the link to the plans. */
  slug?: string;
}

/** A priority a team can set a rule for. */
type SlaPriority = (typeof SLA_PRIORITIES)[number];

/** The settings field each priority's hours are stored in. */
const HOURS_FIELD: Record<
  SlaPriority,
  'urgent_hours' | 'high_hours' | 'medium_hours' | 'low_hours'
> = {
  urgent: 'urgent_hours',
  high: 'high_hours',
  medium: 'medium_hours',
  low: 'low_hours',
};

/** The rules a team reads as until it saves its own. */
const DEFAULT_SLA: Omit<SlaSettingsRead, 'team_id' | 'updated_at'> = {
  enabled: false,
  urgent_hours: 24,
  high_hours: 72,
  medium_hours: null,
  low_hours: null,
  paused_status_ids: [],
  start_mode: 'on_triage_exit',
  calendar: 'calendar',
};

/** The clocks the "Count time" select offers, in order. */
const CALENDARS: { value: SlaCalendar; label: string }[] = [
  { value: 'calendar', label: 'Every day' },
  { value: 'business_days', label: 'Business days only' },
];

/** The start modes the "Start timer" select offers, in order. */
const START_MODES: { value: SlaStartMode; label: string }[] = [
  { value: 'on_triage_exit', label: 'When the issue leaves triage' },
  { value: 'on_creation', label: 'When the issue is created' },
];

/** The status categories an SLA counts time in, so the ones it can pause. */
const OPEN_CATEGORIES = new Set<StatusCategory>([
  'backlog',
  'unstarted',
  'started',
]);

/** The select value that stands for no rule. */
const OFF = 'off';

/** How often the rules are re-read while the settings tab is open. */
const POLL_MS = 60000;

/** The choices a priority's select offers, with a stored value off the list. */
const choicesFor = (current: number | null): (number | null)[] =>
  current === null || SLA_HOUR_CHOICES.includes(current)
    ? [...SLA_HOUR_CHOICES]
    : [...SLA_HOUR_CHOICES, current].sort(
        (left, right) => (left ?? 0) - (right ?? 0)
      );

/** Shows and edits a team's SLA rules. */
export const SlaSection: React.FC<SlaSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
  planIncluded = true,
  slug = '',
}) => {
  const auth = useQueryAuth();
  const baseId = useId();
  const switchLabelId = `${baseId}-enabled`;
  const pausedLabelId = `${baseId}-paused`;
  const startModeId = `${baseId}-start-mode`;
  const calendarId = `${baseId}-calendar`;
  const queryKey: QueryKey = ['sla-settings', workspaceId, teamId];

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => getSlaSettings(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const {
    mutate: save,
    error: saveError,
    isMutating: saving,
  } = useMutationWithRefetch(
    (body: SlaSettingsUpdate) => updateSlaSettings(workspaceId, teamId, body),
    [queryKey]
  );

  const { data: statuses } = usePolledQuery(
    (context) => listStatuses(workspaceId, teamId, context),
    {
      intervalMs: POLL_MS,
      queryKey: ['sla-statuses', workspaceId, teamId],
      auth,
    }
  );

  const current = data ?? DEFAULT_SLA;
  const enabled = current.enabled;
  const paused = current.paused_status_ids ?? [];
  const startMode: SlaStartMode = current.start_mode ?? 'on_triage_exit';
  const calendar: SlaCalendar = current.calendar ?? 'calendar';
  const pausable = (statuses ?? [])
    .filter(
      (status) =>
        OPEN_CATEGORIES.has(status.category) &&
        (!status.hidden || paused.includes(status.id))
    )
    .sort((a, b) => a.position - b.position);
  const switchLocked = !planIncluded && !enabled;

  const apply = async (
    body: SlaSettingsUpdate,
    message: string
  ): Promise<void> => {
    if (!canEdit || saving) return;
    try {
      await save(body);
      await refetch();
      showToast(message);
    } catch {
      return;
    }
  };

  const onHours = (priority: SlaPriority, raw: string): void => {
    const field = HOURS_FIELD[priority];
    const hours = raw === OFF ? null : Number(raw);
    if (hours !== null && !Number.isInteger(hours)) return;
    if (hours === current[field]) return;
    const body: SlaSettingsUpdate = {};
    body[field] = hours;
    void apply(body, 'SLA saved.');
  };

  const onStartMode = (raw: string): void => {
    const next = START_MODES.find((mode) => mode.value === raw)?.value;
    if (next === undefined || next === startMode) return;
    void apply(
      { start_mode: next },
      next === 'on_creation'
        ? 'SLA timers count from creation.'
        : 'SLA timers start when issues leave triage.'
    );
  };

  const onCalendar = (raw: string): void => {
    const next = CALENDARS.find((choice) => choice.value === raw)?.value;
    if (next === undefined || next === calendar) return;
    void apply(
      { calendar: next },
      next === 'business_days'
        ? 'SLA timers skip weekends.'
        : 'SLA timers count every day.'
    );
  };

  const onPause = (statusId: string, checked: boolean): void => {
    const next = checked
      ? [...paused.filter((id) => id !== statusId), statusId]
      : paused.filter((id) => id !== statusId);
    void apply(
      { paused_status_ids: next },
      checked
        ? 'SLA timer pauses in that status.'
        : 'SLA timer runs in that status.'
    );
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">SLAs</h3>
        <p className="text-sm text-text-muted">
          Set how long an issue of each priority may stay open before it
          breaches. Pick whether the timer starts when the issue leaves triage
          or when it is created.
        </p>
      </div>

      {!planIncluded && (
        <PlanRequiredNote feature="issue_slas" name="SLAs" slug={slug} />
      )}

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the SLA settings.')}
        />
      )}
      {saveError !== null && (
        <ErrorAlert
          message={errorMessage(saveError, 'Could not save the SLA settings.')}
        />
      )}

      {isLoading && data === null ? (
        <Spinner label="Loading the SLA settings" />
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          <li className="flex min-h-row items-center justify-between gap-4 px-3 py-2">
            <div className="min-w-0">
              <span
                id={switchLabelId}
                className="block text-sm font-medium text-text"
              >
                Use SLAs
              </span>
              <p className="text-xs text-text-muted">
                Changes apply to SLAs that start after they are saved.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-labelledby={switchLabelId}
              disabled={!canEdit || saving || switchLocked}
              onClick={() => {
                void apply(
                  { enabled: !enabled },
                  enabled ? 'SLAs turned off.' : 'SLAs turned on.'
                );
              }}
              className={cn(
                'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-transparent transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60',
                enabled
                  ? 'bg-accent enabled:hover:bg-accent-strong'
                  : 'bg-line-strong enabled:hover:bg-text-faint'
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'inline-block h-3 w-3 rounded-full bg-bg shadow-sm transition-transform duration-100',
                  enabled ? 'translate-x-3' : 'translate-x-0'
                )}
              />
            </button>
          </li>
          <li className="flex min-h-row items-center justify-between gap-4 px-3 py-2">
            <div className="min-w-0">
              <label
                htmlFor={startModeId}
                className={cn(
                  'block text-sm font-medium',
                  enabled ? 'text-text' : 'text-text-muted'
                )}
              >
                Start timer
              </label>
              <p className="text-xs text-text-muted">
                A new choice applies from each issue&apos;s next priority,
                status or triage change. Timers already running keep their
                start.
              </p>
            </div>
            <div className="shrink-0">
              <Select
                id={startModeId}
                className="w-60"
                value={startMode}
                disabled={!canEdit || saving || !planIncluded}
                onChange={(event) => {
                  onStartMode(event.target.value);
                }}
              >
                {START_MODES.map((mode) => (
                  <option key={mode.value} value={mode.value}>
                    {mode.label}
                  </option>
                ))}
              </Select>
            </div>
          </li>
          <li className="flex min-h-row items-center justify-between gap-4 px-3 py-2">
            <div className="min-w-0">
              <label
                htmlFor={calendarId}
                className={cn(
                  'block text-sm font-medium',
                  enabled ? 'text-text' : 'text-text-muted'
                )}
              >
                Count time
              </label>
              <p className="text-xs text-text-muted">
                Business days skip Saturdays and Sundays in the team&apos;s
                timezone, so a weekend uses none of an issue&apos;s time.
                Switching moves open timers over, each keeping its start.
              </p>
            </div>
            <div className="shrink-0">
              <Select
                id={calendarId}
                className="w-60"
                value={calendar}
                disabled={!canEdit || saving || !planIncluded}
                onChange={(event) => {
                  onCalendar(event.target.value);
                }}
              >
                {CALENDARS.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </Select>
            </div>
          </li>
          {SLA_PRIORITIES.map((priority) => {
            const controlId = `${baseId}-${priority}`;
            const hours = current[HOURS_FIELD[priority]];
            return (
              <li
                key={priority}
                className="flex min-h-row items-center justify-between gap-4 px-3 py-2"
              >
                <label
                  htmlFor={controlId}
                  className={cn(
                    'min-w-0 text-sm font-medium',
                    enabled ? 'text-text' : 'text-text-muted'
                  )}
                >
                  {PRIORITY_LABELS[priority]}
                </label>
                <div className="shrink-0">
                  <Select
                    id={controlId}
                    className="w-40"
                    value={hours === null ? OFF : String(hours)}
                    disabled={!canEdit || saving || !planIncluded}
                    onChange={(event) => {
                      onHours(priority, event.target.value);
                    }}
                  >
                    {choicesFor(hours).map((choice) => (
                      <option
                        key={choice ?? OFF}
                        value={choice === null ? OFF : String(choice)}
                      >
                        {slaHoursLabel(choice)}
                      </option>
                    ))}
                  </Select>
                </div>
              </li>
            );
          })}
          <li className="space-y-2 px-3 py-2">
            <div className="min-w-0">
              <span
                id={pausedLabelId}
                className={cn(
                  'block text-sm font-medium',
                  enabled ? 'text-text' : 'text-text-muted'
                )}
              >
                Pause the timer in
              </span>
              <p className="text-xs text-text-muted">
                Time an issue spends in these statuses does not count toward a
                breach. It resumes with the time it had left.
              </p>
            </div>
            {pausable.length === 0 ? (
              <p className="text-xs text-text-muted">No open statuses.</p>
            ) : (
              <div
                role="group"
                aria-labelledby={pausedLabelId}
                className="flex flex-wrap gap-x-4 gap-y-1"
              >
                {pausable.map((status) => (
                  <Checkbox
                    key={status.id}
                    checked={paused.includes(status.id)}
                    disabled={!canEdit || saving || !planIncluded}
                    onChange={(event) => {
                      onPause(status.id, event.target.checked);
                    }}
                    label={
                      <span className="inline-flex items-center gap-1.5">
                        <StatusIcon status={status} statuses={statuses ?? []} />
                        {status.name}
                      </span>
                    }
                  />
                ))}
              </div>
            )}
          </li>
        </ul>
      )}
    </section>
  );
};

export default SlaSection;
