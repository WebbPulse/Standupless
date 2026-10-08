/**
 * A team's SLA rules: a switch that turns them on, and per priority how long
 * an issue may stay open before it breaches. The timer starts when an issue
 * is created, or when it is accepted from triage.
 *
 * Every control is one choice, so each saves as soon as it is picked rather
 * than through a draft. A rule is stamped onto an issue when its SLA starts,
 * so a change only reaches SLAs that start after it, which the hint says.
 * SLAs need the Business plan, so on a lower plan the rules are read only, the
 * switch only turns off, and a note links to the plans.
 */

import React, { useId } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
  type QueryKey,
} from '@webbpulse/api-client/react';
import { getSlaSettings, updateSlaSettings } from '../../api/teams';
import type { SlaSettingsRead, SlaSettingsUpdate } from '../../types/Api';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { PRIORITY_LABELS } from '../../lib/issueDisplay';
import { SLA_HOUR_CHOICES, SLA_PRIORITIES, slaHoursLabel } from '../../lib/sla';
import { showToast } from '../../lib/toast';
import { ErrorAlert } from '../ui/alert';
import { Select } from '../ui/select';
import Spinner from '../ui/spinner';
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
};

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

  const current = data ?? DEFAULT_SLA;
  const enabled = current.enabled;
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

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">SLAs</h3>
        <p className="text-sm text-text-muted">
          Set how long an issue of each priority may stay open before it
          breaches. The timer starts when the issue is created or accepted from
          triage.
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
        </ul>
      )}
    </section>
  );
};

export default SlaSection;
