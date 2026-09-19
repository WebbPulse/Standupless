/**
 * The pull request transition rules of one project: which status an issue moves
 * to when a linked pull request opens, is marked ready, merges or closes.
 *
 * A project that has set no rule for a trigger inherits the product default,
 * which the API returns marked `is_default`. Those rows are shown as inherited
 * rather than as something a person chose, so that clearing a rule reads as
 * going back to the default instead of turning the behaviour off.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  createTransition,
  deleteTransition,
  listTransitions,
  updateTransition,
} from '../../api/integrations';
import { listStatuses } from '../../api/projects';
import { errorMessage } from '../../lib/errors';
import { statusesKey, transitionsKey } from '../../lib/queryKeys';
import {
  TRANSITION_TRIGGERS,
  type TransitionRead,
  type TransitionTrigger,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import { Select } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for TransitionsSection: which project, and whether the caller may edit. */
export interface TransitionsSectionProps {
  workspaceId: string;
  projectId: string;
  canEdit: boolean;
}

/** How often the rules are re-read while the settings tab is open. */
const POLL_MS = 30000;

/** How each trigger reads in the interface. */
const TRIGGER_LABELS: Record<TransitionTrigger, string> = {
  pr_opened: 'A pull request opens',
  pr_ready_for_review: 'A pull request is marked ready for review',
  pr_merged: 'A pull request merges',
  pr_closed: 'A pull request closes without merging',
};

/** Shows one rule per trigger and lets an admin change where each one lands. */
export const TransitionsSection: React.FC<TransitionsSectionProps> = ({
  workspaceId,
  projectId,
  canEdit,
}) => {
  const auth = useQueryAuth();
  const queryKey = transitionsKey(workspaceId, projectId);
  const [pending, setPending] = useState<string | null>(null);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listTransitions(workspaceId, projectId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const { data: statuses, error: statusesError } = usePolledQuery(
    ({ signal }) => listStatuses(workspaceId, projectId, signal),
    { intervalMs: POLL_MS, queryKey: statusesKey(projectId), auth }
  );

  const { mutate: add, error: addError } = useMutationWithRefetch(
    (input: { trigger: string; statusId: string | null }) =>
      createTransition(workspaceId, projectId, {
        trigger: input.trigger,
        status_id: input.statusId,
      }),
    queryKey
  );

  const { mutate: change, error: changeError } = useMutationWithRefetch(
    (input: { transitionId: string; statusId: string | null }) =>
      updateTransition(workspaceId, projectId, input.transitionId, {
        status_id: input.statusId,
      }),
    queryKey
  );

  const { mutate: reset, error: resetError } = useMutationWithRefetch(
    (transitionId: string) =>
      deleteTransition(workspaceId, projectId, transitionId),
    queryKey
  );

  const byTrigger = new Map<string, TransitionRead>(
    (data ?? []).map((rule) => [rule.trigger, rule])
  );

  const onPick = (trigger: TransitionTrigger, value: string): void => {
    const rule = byTrigger.get(trigger);
    const statusId = value === '' ? null : value;
    setPending(trigger);
    const done = (): void => {
      setPending(null);
    };
    if (rule === undefined || rule.is_default) {
      void add({ trigger, statusId }).then(done, done);
      return;
    }
    void change({ transitionId: rule.transition_id, statusId }).then(
      done,
      done
    );
  };

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium text-white">
        Pull request transitions
      </h2>
      <p className="text-sm text-slate-400">
        A pull request naming an issue key from this project moves that issue.
        An issue somebody moved by hand after the pull request event is left
        alone.
      </p>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the transition rules.')}
        />
      )}
      {statusesError !== null && (
        <ErrorAlert
          message={errorMessage(statusesError, 'Could not load the statuses.')}
        />
      )}
      {addError !== null && (
        <ErrorAlert
          message={errorMessage(addError, 'Could not set that rule.')}
        />
      )}
      {changeError !== null && (
        <ErrorAlert
          message={errorMessage(changeError, 'Could not change that rule.')}
        />
      )}
      {resetError !== null && (
        <ErrorAlert
          message={errorMessage(resetError, 'Could not clear that rule.')}
        />
      )}

      {isLoading || data === null || data === undefined ? (
        <Spinner label="Loading transition rules" />
      ) : (
        <ul className="space-y-2">
          {TRANSITION_TRIGGERS.map((trigger) => {
            const rule = byTrigger.get(trigger);
            const inherited = rule === undefined || rule.is_default;
            return (
              <li
                key={trigger}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-700 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-slate-100">
                    {TRIGGER_LABELS[trigger]}
                  </p>
                  <p className="text-xs text-slate-500">
                    {inherited ? 'Inherited default' : 'Set for this project'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    id={`transition-${trigger}`}
                    aria-label={TRIGGER_LABELS[trigger]}
                    value={rule?.status_id ?? ''}
                    disabled={!canEdit || pending === trigger}
                    onChange={(event) => {
                      onPick(trigger, event.target.value);
                    }}
                  >
                    <option value="">Do not move the issue</option>
                    {(statuses ?? []).map((status) => (
                      <option key={status.id} value={status.id}>
                        {status.name}
                      </option>
                    ))}
                  </Select>
                  {canEdit && rule !== undefined && !rule.is_default && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        void reset(rule.transition_id).catch(() => undefined);
                      }}
                    >
                      Use default
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export default TransitionsSection;
