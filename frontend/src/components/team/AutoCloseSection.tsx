/**
 * A team's auto-close setting: after how long without an update its backlog
 * and triage issues are closed, and the canceled status they move to.
 *
 * Each choice saves as soon as it is picked rather than through a draft, like
 * the auto-archive section beside it. The sweep runs hourly, which the hint
 * says, so a shorter period takes effect within the hour.
 */

import React, { useId } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
  type QueryKey,
} from '@webbpulse/api-client/react';
import {
  getAutoCloseSettings,
  listStatuses,
  updateAutoCloseSettings,
} from '../../api/teams';
import type {
  AutoClosePeriodMonths,
  AutoCloseSettingsUpdate,
} from '../../types/Api';
import { errorMessage } from '../../lib/errors';
import { showToast } from '../../lib/toast';
import { ErrorAlert } from '../ui/alert';
import { Select } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for AutoCloseSection: which team, and whether the caller may edit. */
export interface AutoCloseSectionProps {
  workspaceId: string;
  teamId: string;
  /** Whether the caller administers the team. */
  canEdit: boolean;
}

/** The periods a team may choose, in months. */
const AUTO_CLOSE_PERIODS: readonly AutoClosePeriodMonths[] = [1, 3, 6, 9, 12];

/** The select value that turns auto-close off. */
const OFF = 'off';

/** The select value that closes into the team's first canceled status. */
const FIRST = 'first';

/** How often the setting is re-read while the settings tab is open. */
const POLL_MS = 60000;

/** How one period reads in the select, such as "After 3 months". */
const periodLabel = (months: number): string =>
  months === 1 ? 'After 1 month' : `After ${String(months)} months`;

const isPeriod = (value: number): value is AutoClosePeriodMonths =>
  (AUTO_CLOSE_PERIODS as readonly number[]).includes(value);

/** Shows and edits a team's auto-close period and target status. */
export const AutoCloseSection: React.FC<AutoCloseSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
}) => {
  const auth = useQueryAuth();
  const periodId = useId();
  const statusId = useId();
  const queryKey: QueryKey = ['auto-close-settings', workspaceId, teamId];

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => getAutoCloseSettings(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const { data: statuses } = usePolledQuery(
    ({ signal }) => listStatuses(workspaceId, teamId, signal),
    {
      intervalMs: POLL_MS,
      queryKey: ['auto-close-statuses', workspaceId, teamId],
      auth,
    }
  );

  const cancelled = (statuses ?? [])
    .filter((status) => status.category === 'cancelled' && !status.hidden)
    .sort((a, b) => a.position - b.position);

  const {
    mutate: save,
    error: saveError,
    isMutating: saving,
  } = useMutationWithRefetch(
    (body: AutoCloseSettingsUpdate) =>
      updateAutoCloseSettings(workspaceId, teamId, body),
    [queryKey]
  );

  const period = data?.period_months ?? null;
  const target = data?.status_id ?? null;

  const submit = async (
    body: AutoCloseSettingsUpdate,
    message: string
  ): Promise<void> => {
    if (!canEdit) return;
    try {
      await save(body);
      await refetch();
      showToast(message);
    } catch {
      return;
    }
  };

  const onPeriod = async (value: string): Promise<void> => {
    const next = value === OFF ? null : Number(value);
    if (next === period || (next !== null && !isPeriod(next))) return;
    await submit(
      { period_months: next },
      next === null ? 'Auto-close turned off.' : 'Auto-close period saved.'
    );
  };

  const onStatus = async (value: string): Promise<void> => {
    const next = value === FIRST ? null : value;
    if (next === target) return;
    await submit({ status_id: next }, 'Auto-close status saved.');
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Auto-close</h3>
        <p className="text-sm text-text-muted">
          Backlog and triage issues that have not been updated for the chosen
          period are closed into a canceled status. Planned and started issues
          are never closed, and snoozed triage issues wait until they wake.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(
            error,
            'Could not load the auto-close setting.'
          )}
        />
      )}
      {saveError !== null && (
        <ErrorAlert
          message={errorMessage(
            saveError,
            'Could not save the auto-close setting.'
          )}
        />
      )}

      {isLoading && data === null ? (
        <Spinner label="Loading the auto-close setting" />
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          <li className="flex min-h-row items-center justify-between gap-4 px-3 py-2">
            <div className="min-w-0">
              <label
                htmlFor={periodId}
                className="block text-sm font-medium text-text"
              >
                Auto-close stale issues
              </label>
              <p className="text-xs text-text-muted">
                Checked hourly, counted from the issue&apos;s last update.
              </p>
            </div>
            <div className="shrink-0">
              <Select
                id={periodId}
                className="w-40"
                value={period === null ? OFF : String(period)}
                disabled={!canEdit || saving}
                onChange={(event) => {
                  void onPeriod(event.target.value);
                }}
              >
                <option value={OFF}>Off</option>
                {AUTO_CLOSE_PERIODS.map((months) => (
                  <option key={months} value={months}>
                    {periodLabel(months)}
                  </option>
                ))}
              </Select>
            </div>
          </li>
          {period !== null && (
            <li className="flex min-h-row items-center justify-between gap-4 px-3 py-2">
              <div className="min-w-0">
                <label
                  htmlFor={statusId}
                  className="block text-sm font-medium text-text"
                >
                  Close into
                </label>
                <p className="text-xs text-text-muted">
                  The canceled status closed issues move to.
                </p>
              </div>
              <div className="shrink-0">
                <Select
                  id={statusId}
                  className="w-40"
                  value={target ?? FIRST}
                  disabled={!canEdit || saving}
                  onChange={(event) => {
                    void onStatus(event.target.value);
                  }}
                >
                  <option value={FIRST}>First canceled status</option>
                  {cancelled.map((status) => (
                    <option key={status.id} value={status.id}>
                      {status.name}
                    </option>
                  ))}
                </Select>
              </div>
            </li>
          )}
        </ul>
      )}
    </section>
  );
};

export default AutoCloseSection;
