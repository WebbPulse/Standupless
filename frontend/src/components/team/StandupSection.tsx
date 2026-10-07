/**
 * A team's standup digest schedule: off, daily on weekdays or weekly, cut at a
 * local send time in the team's timezone. The page at the team's Standup tab
 * reads any date whatever the schedule; this only says when one is cut.
 *
 * The fields depend on each other, the weekday only meaning something for a
 * weekly digest, so they edit as one draft and save together.
 */

import React, { useId, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
  type QueryKey,
} from '@webbpulse/api-client/react';
import { getStandupSettings, updateStandupSettings } from '../../api/standup';
import type { StandupCadence, StandupSettingsRead } from '../../types/Api';
import { errorMessage } from '../../lib/errors';
import { showToast } from '../../lib/toast';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for StandupSection: which team, and whether the caller may edit. */
export interface StandupSectionProps {
  workspaceId: string;
  teamId: string;
  /** Whether the caller administers the team. */
  canEdit: boolean;
}

/** How often the settings are re-read while the settings tab is open. */
const POLL_MS = 60000;

const CADENCES: readonly { value: StandupCadence; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'daily', label: 'Daily, on weekdays' },
  { value: 'weekly', label: 'Weekly' },
];

const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** The draft the form edits, in the shape the settings read. */
interface Draft {
  cadence: StandupCadence;
  send_time: string;
  timezone: string;
  weekday: number;
}

const draftOf = (settings: StandupSettingsRead): Draft => ({
  cadence: settings.cadence,
  send_time: settings.send_time,
  timezone: settings.timezone,
  weekday: settings.weekday,
});

const isCadence = (value: string): value is StandupCadence =>
  CADENCES.some((row) => row.value === value);

/** Every timezone the browser knows, for the picker's suggestions. */
const knownZones = (): string[] => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
};

/** Shows and edits a team's standup digest schedule. */
export const StandupSection: React.FC<StandupSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
}) => {
  const auth = useQueryAuth();
  const baseId = useId();
  const queryKey: QueryKey = ['standup-settings', workspaceId, teamId];
  const zones = useMemo(knownZones, []);

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => getStandupSettings(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const [edits, setEdits] = useState<Partial<Draft>>({});
  const saved = data === null ? null : draftOf(data);
  const draft = saved === null ? null : { ...saved, ...edits };

  const {
    mutate: save,
    error: saveError,
    isMutating: saving,
  } = useMutationWithRefetch(
    (body: Draft) => updateStandupSettings(workspaceId, teamId, body),
    [queryKey]
  );

  const dirty =
    draft !== null &&
    saved !== null &&
    JSON.stringify(draft) !== JSON.stringify(saved);

  const onSave = async (): Promise<void> => {
    if (draft === null || !dirty || !canEdit) return;
    try {
      await save(draft);
      await refetch();
      setEdits({});
      showToast('Standup schedule saved.');
    } catch {
      return;
    }
  };

  const change = (patch: Partial<Draft>): void => {
    setEdits((current) => ({ ...current, ...patch }));
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Standup</h3>
        <p className="text-sm text-text-muted">
          A digest of what each member completed, started, commented on and has
          blocked or due, built from the team&apos;s own activity. Members can
          add a note to the next one from the Standup tab.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the standup schedule.')}
        />
      )}
      {saveError !== null && (
        <ErrorAlert
          message={errorMessage(
            saveError,
            'Could not save the standup schedule.'
          )}
        />
      )}

      {draft === null ? (
        isLoading ? (
          <Spinner label="Loading the standup schedule" />
        ) : null
      ) : (
        <div className="space-y-3">
          <ul className="divide-y divide-line rounded-md border border-line">
            <li className="flex min-h-row items-center justify-between gap-4 px-3 py-2">
              <label
                htmlFor={`${baseId}-cadence`}
                className="text-sm font-medium text-text"
              >
                Digest
              </label>
              <Select
                id={`${baseId}-cadence`}
                className="w-48"
                value={draft.cadence}
                disabled={!canEdit || saving}
                onChange={(event) => {
                  const value = event.target.value;
                  if (isCadence(value)) change({ cadence: value });
                }}
              >
                {CADENCES.map((row) => (
                  <option key={row.value} value={row.value}>
                    {row.label}
                  </option>
                ))}
              </Select>
            </li>
            {draft.cadence === 'weekly' && (
              <li className="flex min-h-row items-center justify-between gap-4 px-3 py-2">
                <label
                  htmlFor={`${baseId}-weekday`}
                  className="text-sm font-medium text-text"
                >
                  Send on
                </label>
                <Select
                  id={`${baseId}-weekday`}
                  className="w-48"
                  value={String(draft.weekday)}
                  disabled={!canEdit || saving}
                  onChange={(event) => {
                    change({ weekday: Number(event.target.value) });
                  }}
                >
                  {WEEKDAYS.map((name, index) => (
                    <option key={name} value={index}>
                      {name}
                    </option>
                  ))}
                </Select>
              </li>
            )}
            <li className="flex min-h-row items-center justify-between gap-4 px-3 py-2">
              <label
                htmlFor={`${baseId}-time`}
                className="text-sm font-medium text-text"
              >
                Send time
              </label>
              <Input
                id={`${baseId}-time`}
                type="time"
                className="w-48"
                value={draft.send_time}
                disabled={!canEdit || saving}
                onChange={(event) => {
                  change({ send_time: event.target.value });
                }}
              />
            </li>
            <li className="flex min-h-row items-center justify-between gap-4 px-3 py-2">
              <label
                htmlFor={`${baseId}-zone`}
                className="text-sm font-medium text-text"
              >
                Timezone
              </label>
              <Input
                id={`${baseId}-zone`}
                className="w-48"
                list={`${baseId}-zones`}
                value={draft.timezone}
                disabled={!canEdit || saving}
                onChange={(event) => {
                  change({ timezone: event.target.value });
                }}
              />
              <datalist id={`${baseId}-zones`}>
                {zones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </li>
          </ul>
          {data !== null && (
            <p className="text-xs text-text-muted">
              Next digest: {data.next_digest_date}
              {data.cadence === 'off' ? ', viewable but not sent.' : '.'}
            </p>
          )}
          {canEdit && (
            <div className="flex justify-end">
              <Button
                variant="primary"
                size="sm"
                disabled={!dirty || saving}
                onClick={() => {
                  void onSave();
                }}
              >
                Save
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default StandupSection;
