/**
 * A team's auto-archive period: how long an issue stays in the team's lists
 * and board after it was completed or canceled.
 *
 * The setting is one choice, so it saves as soon as it is picked rather than
 * through a draft. The sweep runs hourly, so a shorter period takes effect
 * within the hour rather than at once, which the hint says.
 */

import React, { useId } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
  type QueryKey,
} from '@webbpulse/api-client/react';
import { getArchiveSettings, updateArchiveSettings } from '../../api/teams';
import type { ArchivePeriodMonths } from '../../types/Api';
import { errorMessage } from '../../lib/errors';
import { showToast } from '../../lib/toast';
import { ErrorAlert } from '../ui/alert';
import { Select } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for AutoArchiveSection: which team, and whether the caller may edit. */
export interface AutoArchiveSectionProps {
  workspaceId: string;
  teamId: string;
  /** Whether the caller administers the team. */
  canEdit: boolean;
}

/** The periods a team may choose, in months. */
const ARCHIVE_PERIODS: readonly ArchivePeriodMonths[] = [1, 3, 6, 9, 12];

/** The period a team archives after until it chooses one. */
const DEFAULT_ARCHIVE_PERIOD: ArchivePeriodMonths = 6;

/** How often the setting is re-read while the settings tab is open. */
const POLL_MS = 60000;

/** How one period reads in the select, such as "After 3 months". */
const periodLabel = (months: number): string =>
  months === 1 ? 'After 1 month' : `After ${String(months)} months`;

const isPeriod = (value: number): value is ArchivePeriodMonths =>
  (ARCHIVE_PERIODS as readonly number[]).includes(value);

/** Shows and edits a team's auto-archive period. */
export const AutoArchiveSection: React.FC<AutoArchiveSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
}) => {
  const auth = useQueryAuth();
  const controlId = useId();
  const queryKey: QueryKey = ['archive-settings', workspaceId, teamId];

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => getArchiveSettings(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const {
    mutate: save,
    error: saveError,
    isMutating: saving,
  } = useMutationWithRefetch(
    (period_months: ArchivePeriodMonths) =>
      updateArchiveSettings(workspaceId, teamId, { period_months }),
    [queryKey]
  );

  const current = data?.period_months ?? DEFAULT_ARCHIVE_PERIOD;

  const onChange = async (value: number): Promise<void> => {
    if (!isPeriod(value) || value === current || !canEdit) return;
    try {
      await save(value);
      await refetch();
      showToast('Auto-archive period saved.');
    } catch {
      return;
    }
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Auto-archive</h3>
        <p className="text-sm text-text-muted">
          Completed and canceled issues are archived once they have been closed
          for the chosen period. Archived issues leave lists and boards, but
          stay searchable, open by their key, and can be restored.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(
            error,
            'Could not load the auto-archive setting.'
          )}
        />
      )}
      {saveError !== null && (
        <ErrorAlert
          message={errorMessage(
            saveError,
            'Could not save the auto-archive setting.'
          )}
        />
      )}

      {isLoading && data === null ? (
        <Spinner label="Loading the auto-archive setting" />
      ) : (
        <ul className="rounded-md border border-line">
          <li className="flex min-h-row items-center justify-between gap-4 px-3 py-2">
            <div className="min-w-0">
              <label
                htmlFor={controlId}
                className="block text-sm font-medium text-text"
              >
                Auto-archive closed issues
              </label>
              <p className="text-xs text-text-muted">
                Checked hourly, counted from the issue&apos;s last update.
              </p>
            </div>
            <div className="shrink-0">
              <Select
                id={controlId}
                className="w-40"
                value={String(current)}
                disabled={!canEdit || saving}
                onChange={(event) => {
                  void onChange(Number(event.target.value));
                }}
              >
                {ARCHIVE_PERIODS.map((months) => (
                  <option key={months} value={months}>
                    {periodLabel(months)}
                  </option>
                ))}
              </Select>
            </div>
          </li>
        </ul>
      )}
    </section>
  );
};

export default AutoArchiveSection;
