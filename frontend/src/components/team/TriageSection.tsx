/**
 * A team's triage switch. While it is on, issues filed by guests, integrations
 * and people outside the team wait in the team's triage inbox instead of
 * landing in its lists and board, until a member accepts, declines, marks as
 * duplicate or snoozes them.
 *
 * The setting is one choice, so it saves as soon as it is flipped.
 */

import React, { useId } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import { getTriageSettings, updateTriageSettings } from '../../api/triage';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { triageSettingsKey, triageSummaryKey } from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import { ErrorAlert } from '../ui/alert';
import Spinner from '../ui/spinner';

/** Props for TriageSection: which team, and whether the caller may edit. */
export interface TriageSectionProps {
  workspaceId: string;
  teamId: string;
  /** Whether the caller administers the team. */
  canEdit: boolean;
}

/** How often the setting is re-read while the settings tab is open. */
const POLL_MS = 60000;

/** Shows and flips a team's triage switch. */
export const TriageSection: React.FC<TriageSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
}) => {
  const auth = useQueryAuth();
  const labelId = useId();
  const queryKey = triageSettingsKey(workspaceId, teamId);

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => getTriageSettings(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const {
    mutate: save,
    error: saveError,
    isMutating: saving,
  } = useMutationWithRefetch(
    (enabled: boolean) =>
      updateTriageSettings(workspaceId, teamId, { enabled }),
    [queryKey, triageSummaryKey(workspaceId)]
  );

  const enabled = data?.enabled ?? false;

  const onFlip = async (): Promise<void> => {
    if (!canEdit || saving) return;
    try {
      await save(!enabled);
      await refetch();
      showToast(enabled ? 'Triage turned off.' : 'Triage turned on.');
    } catch {
      return;
    }
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Triage</h3>
        <p className="text-sm text-text-muted">
          Issues filed by guests, integrations and people outside the team wait
          in a triage inbox until a member accepts, declines, marks them as a
          duplicate or snoozes them. Team members can still file straight into
          the team.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the triage setting.')}
        />
      )}
      {saveError !== null && (
        <ErrorAlert
          message={errorMessage(
            saveError,
            'Could not save the triage setting.'
          )}
        />
      )}

      {isLoading && data === null ? (
        <Spinner label="Loading the triage setting" />
      ) : (
        <ul className="rounded-md border border-line">
          <li className="flex min-h-row items-center justify-between gap-4 px-3 py-2">
            <div className="min-w-0">
              <span
                id={labelId}
                className="block text-sm font-medium text-text"
              >
                Use a triage inbox
              </span>
              <p className="text-xs text-text-muted">
                Turning it off leaves waiting issues in the inbox until worked.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-labelledby={labelId}
              disabled={!canEdit || saving}
              onClick={() => {
                void onFlip();
              }}
              className={cn(
                'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-transparent transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60',
                enabled ? 'bg-accent' : 'bg-line-strong'
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
        </ul>
      )}
    </section>
  );
};

export default TriageSection;
