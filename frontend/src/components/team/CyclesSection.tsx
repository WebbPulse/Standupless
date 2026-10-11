/**
 * A team's automatic cycles: whether the team works in cycles, how long each
 * one runs, the cooldown between them, the weekday they start on, how many
 * are created ahead, and whether issues that start join the current cycle.
 *
 * Changes are held as a draft and saved together, because turning cycles on
 * or changing the length makes the server lay out the current and upcoming
 * cycles, and that should happen once for a finished schedule rather than on
 * every control a person passes through. A preview line shows the dates the
 * draft would give before anything is saved.
 */

import React, { useId, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
  type QueryKey,
} from '@webbpulse/api-client/react';
import { getCycleSettings, updateCycleSettings } from '../../api/teams';
import {
  COOLDOWN_WEEKS,
  DEFAULT_CYCLE_SCHEDULE,
  DURATION_WEEKS,
  UPCOMING_COUNTS,
  WEEKDAYS,
  formatPreviewDate,
  previewNextCycle,
  scheduleChanges,
  scheduleOf,
  weeksLabel,
  type CycleSchedule,
} from '../../lib/cycleSettings';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { cyclesKey, planningOptionsKey } from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import { Select } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for CyclesSection: which team, and whether the caller may edit. */
export interface CyclesSectionProps {
  workspaceId: string;
  teamId: string;
  /** Whether the caller administers the team. */
  canEdit: boolean;
  /** Whether the team is a sub-team, which runs on its parent's schedule. */
  inherited?: boolean | undefined;
}

/** How often the schedule is re-read while the settings tab is open. */
const POLL_MS = 30000;

/** Props for the on and off switch a settings row ends in. */
interface ToggleProps {
  id: string;
  checked: boolean;
  disabled: boolean;
  labelledBy: string;
  onChange: (checked: boolean) => void;
}

/** An on and off switch, announced as a switch. */
const Toggle: React.FC<ToggleProps> = ({
  id,
  checked,
  disabled,
  labelledBy,
  onChange,
}) => (
  <button
    id={id}
    type="button"
    role="switch"
    aria-checked={checked}
    aria-labelledby={labelledBy}
    disabled={disabled}
    onClick={() => {
      onChange(!checked);
    }}
    className={cn(
      'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-transparent transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60',
      checked
        ? 'bg-accent enabled:hover:bg-accent-strong'
        : 'bg-line-strong enabled:hover:bg-text-faint',
      'enabled:active:brightness-90'
    )}
  >
    <span
      aria-hidden="true"
      className={cn(
        'inline-block h-3 w-3 rounded-full bg-bg shadow-sm transition-transform duration-100',
        checked ? 'translate-x-3' : 'translate-x-0'
      )}
    />
  </button>
);

/** Props for one labelled settings row. */
interface RowProps {
  labelId: string;
  controlId: string;
  label: string;
  hint: string;
  children: React.ReactNode;
}

/** One setting: its name and a line on what it does, with the control beside them. */
const Row: React.FC<RowProps> = ({
  labelId,
  controlId,
  label,
  hint,
  children,
}) => (
  <li className="flex min-h-row items-center justify-between gap-4 border-b border-line px-3 py-2 last:border-b-0">
    <div className="min-w-0">
      <label
        id={labelId}
        htmlFor={controlId}
        className="block text-sm font-medium text-text"
      >
        {label}
      </label>
      <p className="text-xs text-text-muted">{hint}</p>
    </div>
    <div className="shrink-0">{children}</div>
  </li>
);

/** Shows and edits a team's automatic cycle schedule. */
export const CyclesSection: React.FC<CyclesSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
  inherited = false,
}) => {
  const auth = useQueryAuth();
  const prefix = useId();
  const queryKey: QueryKey = ['cycle-settings', workspaceId, teamId];
  const [draft, setDraft] = useState<CycleSchedule | null>(null);
  const [today] = useState(() => new Date());

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => getCycleSettings(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const {
    mutate: save,
    error: saveError,
    isMutating: saving,
  } = useMutationWithRefetch(
    (changes: Partial<CycleSchedule>) =>
      updateCycleSettings(workspaceId, teamId, changes),
    [
      queryKey,
      cyclesKey(workspaceId, teamId, ''),
      ['cycleVelocity', workspaceId, teamId],
      planningOptionsKey(teamId),
    ]
  );

  const saved = data === null ? DEFAULT_CYCLE_SCHEDULE : scheduleOf(data);
  const current = draft ?? saved;
  const changes = scheduleChanges(saved, current);
  const dirty = Object.keys(changes).length > 0;
  const locked = !canEdit || saving || inherited;

  const edit = (patch: Partial<CycleSchedule>): void => {
    setDraft({ ...current, ...patch });
  };

  const onSave = async (): Promise<void> => {
    if (!dirty || locked) return;
    try {
      const result = await save(changes);
      await refetch();
      setDraft(null);
      showToast(
        result.enabled
          ? 'Cycle settings saved. Upcoming cycles are scheduled.'
          : 'Cycle settings saved.'
      );
    } catch {
      return;
    }
  };

  const ids = {
    enabled: `${prefix}-enabled`,
    duration: `${prefix}-duration`,
    cooldown: `${prefix}-cooldown`,
    weekday: `${prefix}-weekday`,
    upcoming: `${prefix}-upcoming`,
    autoAdd: `${prefix}-auto-add`,
    moveUnfinished: `${prefix}-move-unfinished`,
  };

  const preview = previewNextCycle(current, today);

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Cycles</h3>
        <p className="text-sm text-text-muted">
          Work in repeating time boxes. Once cycles are on, the current cycle
          and the upcoming ones are created for you, and unfinished issues roll
          over to the next cycle when one ends.
        </p>
        {inherited && (
          <p className="text-xs text-text-faint">
            This sub-team uses its parent team's cycles. Change them in the
            parent team's settings.
          </p>
        )}
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the cycle settings.')}
        />
      )}
      {saveError !== null && (
        <ErrorAlert
          message={errorMessage(
            saveError,
            'Could not save the cycle settings.'
          )}
        />
      )}

      {isLoading && data === null ? (
        <Spinner label="Loading the cycle settings" />
      ) : (
        <div className="space-y-3">
          <ul className="rounded-md border border-line">
            <Row
              labelId={`${ids.enabled}-label`}
              controlId={ids.enabled}
              label="Enable cycles"
              hint="Plan this team's work in cycles of a fixed length."
            >
              <Toggle
                id={ids.enabled}
                labelledBy={`${ids.enabled}-label`}
                checked={current.enabled}
                disabled={locked}
                onChange={(enabled) => {
                  edit({ enabled });
                }}
              />
            </Row>

            {current.enabled && (
              <>
                <Row
                  labelId={`${ids.duration}-label`}
                  controlId={ids.duration}
                  label="Cycle length"
                  hint="How long each cycle runs."
                >
                  <Select
                    id={ids.duration}
                    className="w-40"
                    value={String(current.duration_weeks)}
                    disabled={locked}
                    onChange={(event) => {
                      edit({ duration_weeks: Number(event.target.value) });
                    }}
                  >
                    {DURATION_WEEKS.map((weeks) => (
                      <option key={weeks} value={weeks}>
                        {weeksLabel(weeks)}
                      </option>
                    ))}
                  </Select>
                </Row>
                <Row
                  labelId={`${ids.cooldown}-label`}
                  controlId={ids.cooldown}
                  label="Cooldown"
                  hint="A gap between cycles for planning and cleanup."
                >
                  <Select
                    id={ids.cooldown}
                    className="w-40"
                    value={String(current.cooldown_weeks)}
                    disabled={locked}
                    onChange={(event) => {
                      edit({ cooldown_weeks: Number(event.target.value) });
                    }}
                  >
                    {COOLDOWN_WEEKS.map((weeks) => (
                      <option key={weeks} value={weeks}>
                        {weeks === 0 ? 'No cooldown' : weeksLabel(weeks)}
                      </option>
                    ))}
                  </Select>
                </Row>
                <Row
                  labelId={`${ids.weekday}-label`}
                  controlId={ids.weekday}
                  label="Cycle start day"
                  hint="The weekday each cycle starts on."
                >
                  <Select
                    id={ids.weekday}
                    className="w-40"
                    value={String(current.start_weekday)}
                    disabled={locked}
                    onChange={(event) => {
                      edit({ start_weekday: Number(event.target.value) });
                    }}
                  >
                    {WEEKDAYS.map((day, index) => (
                      <option key={day} value={index}>
                        {day}
                      </option>
                    ))}
                  </Select>
                </Row>
                <Row
                  labelId={`${ids.upcoming}-label`}
                  controlId={ids.upcoming}
                  label="Upcoming cycles"
                  hint="How many cycles are created ahead of the current one."
                >
                  <Select
                    id={ids.upcoming}
                    className="w-40"
                    value={String(current.upcoming_count)}
                    disabled={locked}
                    onChange={(event) => {
                      edit({ upcoming_count: Number(event.target.value) });
                    }}
                  >
                    {UPCOMING_COUNTS.map((count) => (
                      <option key={count} value={count}>
                        {count === 1 ? '1 cycle' : `${String(count)} cycles`}
                      </option>
                    ))}
                  </Select>
                </Row>
                <Row
                  labelId={`${ids.autoAdd}-label`}
                  controlId={ids.autoAdd}
                  label="Auto-add started issues"
                  hint="Issues moved to a started status join the current cycle."
                >
                  <Toggle
                    id={ids.autoAdd}
                    labelledBy={`${ids.autoAdd}-label`}
                    checked={current.auto_add_started}
                    disabled={locked}
                    onChange={(autoAdd) => {
                      edit({ auto_add_started: autoAdd });
                    }}
                  />
                </Row>
                <Row
                  labelId={`${ids.moveUnfinished}-label`}
                  controlId={ids.moveUnfinished}
                  label="Move unfinished issues to the next cycle"
                  hint="When a cycle ends, issues not completed or cancelled roll into the next one."
                >
                  <Toggle
                    id={ids.moveUnfinished}
                    labelledBy={`${ids.moveUnfinished}-label`}
                    checked={current.move_unfinished}
                    disabled={locked}
                    onChange={(moveUnfinished) => {
                      edit({ move_unfinished: moveUnfinished });
                    }}
                  />
                </Row>
              </>
            )}
          </ul>

          {current.enabled && (
            <p className="text-xs text-text-muted" data-testid="cycle-preview">
              <span className="font-medium text-text">Preview:</span> next cycle
              starts {formatPreviewDate(preview.start)} and ends{' '}
              {formatPreviewDate(preview.end)}
              {current.cooldown_weeks > 0
                ? `, then a ${weeksLabel(current.cooldown_weeks)} cooldown.`
                : '.'}
            </p>
          )}

          {canEdit && !inherited && (
            <div className="flex justify-end gap-2">
              {dirty && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    setDraft(null);
                  }}
                >
                  Discard
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                disabled={!dirty || saving}
                onClick={() => {
                  void onSave();
                }}
              >
                {saving ? 'Saving' : 'Save'}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default CyclesSection;
