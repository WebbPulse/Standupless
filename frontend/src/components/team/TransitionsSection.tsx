/**
 * The pull request transition rules of one team: which status an issue moves
 * to when a linked pull request opens, is marked ready, merges or closes.
 *
 * A team that has set no rule for a trigger inherits the product default,
 * which the API returns marked `is_default`. Those rows are shown as inherited
 * rather than as something a person chose, so that clearing a rule reads as
 * going back to the default instead of turning the behaviour off.
 *
 * A branch rule holds only for pull requests into a branch matching its glob,
 * and beats the any-branch rule for the same trigger. The recommended preset
 * replaces the whole set in one call: review on open or ready, On Staging on a
 * merge into staging and Done on a merge into main.
 */

import React, { useState } from 'react';
import { LuArrowRight } from 'react-icons/lu';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  createTransition,
  deleteTransition,
  listTransitions,
  replaceTransitions,
  updateTransition,
} from '../../api/integrations';
import { listStatuses } from '../../api/teams';
import { errorMessage } from '../../lib/errors';
import { statusesKey, transitionsKey } from '../../lib/queryKeys';
import {
  TRANSITION_TRIGGERS,
  type StatusRead,
  type TransitionCreate,
  type TransitionRead,
  type TransitionTrigger,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for TransitionsSection: which team, and whether the caller may edit. */
export interface TransitionsSectionProps {
  workspaceId: string;
  teamId: string;
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

/** How each trigger reads beside a branch pattern. */
const TRIGGER_SHORT: Record<TransitionTrigger, string> = {
  pr_opened: 'Opens',
  pr_ready_for_review: 'Marked ready',
  pr_merged: 'Merges',
  pr_closed: 'Closes unmerged',
};

/** The status named `name`, ignoring case. */
const named = (statuses: StatusRead[], name: string): StatusRead | undefined =>
  statuses.find((status) => status.name.toLowerCase() === name.toLowerCase());

/**
 * The recommended rule set, or null when the team lacks a status it needs.
 * Done falls back to the first completed status when none is named Done.
 */
const recommendedPreset = (
  statuses: StatusRead[]
): TransitionCreate[] | null => {
  const review = named(statuses, 'In Review');
  const staging = named(statuses, 'On Staging');
  const done =
    named(statuses, 'Done') ??
    statuses.find((status) => status.category === 'completed');
  if (review === undefined || staging === undefined || done === undefined) {
    return null;
  }
  return [
    { trigger: 'pr_opened', status_id: review.id },
    { trigger: 'pr_ready_for_review', status_id: review.id },
    { trigger: 'pr_merged', branch_pattern: 'staging', status_id: staging.id },
    { trigger: 'pr_merged', branch_pattern: 'main', status_id: done.id },
  ];
};

/** Shows one rule per trigger and lets an admin change where each one lands. */
export const TransitionsSection: React.FC<TransitionsSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
}) => {
  const auth = useQueryAuth();
  const queryKey = transitionsKey(workspaceId, teamId);
  const [pending, setPending] = useState<string | null>(null);
  const [newTrigger, setNewTrigger] = useState<TransitionTrigger>('pr_merged');
  const [newPattern, setNewPattern] = useState('');
  const [newStatus, setNewStatus] = useState('');

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listTransitions(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const { data: statuses, error: statusesError } = usePolledQuery(
    ({ signal }) => listStatuses(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey: statusesKey(teamId), auth }
  );

  const { mutate: add, error: addError } = useMutationWithRefetch(
    (input: {
      trigger: string;
      statusId: string | null;
      branchPattern?: string;
    }) =>
      createTransition(workspaceId, teamId, {
        trigger: input.trigger,
        status_id: input.statusId,
        ...(input.branchPattern === undefined
          ? {}
          : { branch_pattern: input.branchPattern }),
      }),
    queryKey
  );

  const { mutate: replace, error: replaceError } = useMutationWithRefetch(
    (rules: TransitionCreate[]) =>
      replaceTransitions(workspaceId, teamId, { rules }),
    queryKey
  );

  const { mutate: change, error: changeError } = useMutationWithRefetch(
    (input: { transitionId: string; statusId: string | null }) =>
      updateTransition(workspaceId, teamId, input.transitionId, {
        status_id: input.statusId,
      }),
    queryKey
  );

  const { mutate: reset, error: resetError } = useMutationWithRefetch(
    (transitionId: string) =>
      deleteTransition(workspaceId, teamId, transitionId),
    queryKey
  );

  const byTrigger = new Map<string, TransitionRead>(
    (data ?? [])
      .filter((rule) => !rule.branch_pattern)
      .map((rule) => [rule.trigger, rule])
  );
  const branchRules = (data ?? []).filter((rule) => rule.branch_pattern);
  const preset = recommendedPreset(statuses ?? []);

  const onAddBranchRule = (event: React.FormEvent): void => {
    event.preventDefault();
    const pattern = newPattern.trim();
    if (pattern === '') {
      return;
    }
    setPending('branch-new');
    const done = (): void => {
      setPending(null);
    };
    void add({
      trigger: newTrigger,
      statusId: newStatus === '' ? null : newStatus,
      branchPattern: pattern,
    }).then(() => {
      setNewPattern('');
      done();
    }, done);
  };

  const onPreset = (): void => {
    if (preset === null) {
      return;
    }
    setPending('preset');
    const done = (): void => {
      setPending(null);
    };
    void replace(preset).then(done, done);
  };

  const statusOptions = (
    <>
      <option value="">Do not move the issue</option>
      {(statuses ?? []).map((status) => (
        <option key={status.id} value={status.id}>
          {status.name}
        </option>
      ))}
    </>
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
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Pull request transitions</h3>
        <p className="text-sm text-text-muted">
          A pull request naming an issue key from this team moves that issue. An
          issue somebody moved by hand after the pull request event is left
          alone.
        </p>
      </div>

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
      {replaceError !== null && (
        <ErrorAlert
          message={errorMessage(
            replaceError,
            'Could not apply the recommended rules.'
          )}
        />
      )}

      {isLoading || data === null || data === undefined ? (
        <Spinner label="Loading transition rules" />
      ) : (
        <ul className="rounded-md border border-line">
          {TRANSITION_TRIGGERS.map((trigger) => {
            const rule = byTrigger.get(trigger);
            const inherited = rule === undefined || rule.is_default;
            return (
              <li
                key={trigger}
                className="grid min-h-row grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-line px-3 py-1.5 transition-colors duration-100 last:border-b-0 hover:bg-surface"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-text">
                    {TRIGGER_LABELS[trigger]}
                  </p>
                  <p className="text-xs text-text-muted">
                    {inherited ? 'Inherited default' : 'Set for this team'}
                  </p>
                </div>
                <LuArrowRight
                  aria-hidden="true"
                  className="h-3.5 w-3.5 text-text-faint"
                />
                <div className="flex items-center gap-1">
                  <Select
                    id={`transition-${trigger}`}
                    aria-label={TRIGGER_LABELS[trigger]}
                    className="w-44"
                    value={rule?.status_id ?? ''}
                    disabled={!canEdit || pending === trigger}
                    onChange={(event) => {
                      onPick(trigger, event.target.value);
                    }}
                  >
                    {statusOptions}
                  </Select>
                  {canEdit && rule !== undefined && !rule.is_default && (
                    <Button
                      variant="ghost"
                      size="sm"
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

      {data !== null && data !== undefined && (
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <h4 className="text-sm font-semibold">Branch rules</h4>
              <p className="text-sm text-text-muted">
                A branch rule applies only to pull requests into a matching
                branch, such as main or release/*, and wins over the rule above
                for the same event.
              </p>
            </div>
            {canEdit && (
              <Button
                variant="secondary"
                size="sm"
                disabled={preset === null || pending === 'preset'}
                title={
                  preset === null
                    ? 'Needs statuses named In Review, On Staging and Done'
                    : undefined
                }
                onClick={onPreset}
              >
                Use recommended rules
              </Button>
            )}
          </div>

          {branchRules.length === 0 ? (
            <p className="text-sm text-text-muted">No branch rules.</p>
          ) : (
            <ul className="rounded-md border border-line">
              {branchRules.map((rule) => {
                const trigger = rule.trigger as TransitionTrigger;
                const label = `${TRIGGER_SHORT[trigger] ?? rule.trigger} into ${rule.branch_pattern ?? ''}`;
                return (
                  <li
                    key={rule.transition_id}
                    className="grid min-h-row grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-line px-3 py-1.5 transition-colors duration-100 last:border-b-0 hover:bg-surface"
                  >
                    <p className="min-w-0 truncate font-medium text-text">
                      {TRIGGER_SHORT[trigger] ?? rule.trigger} into{' '}
                      <code className="font-mono text-xs">
                        {rule.branch_pattern}
                      </code>
                    </p>
                    <LuArrowRight
                      aria-hidden="true"
                      className="h-3.5 w-3.5 text-text-faint"
                    />
                    <div className="flex items-center gap-1">
                      <Select
                        aria-label={label}
                        className="w-44"
                        value={rule.status_id ?? ''}
                        disabled={!canEdit || pending === rule.transition_id}
                        onChange={(event) => {
                          const value = event.target.value;
                          setPending(rule.transition_id);
                          const done = (): void => {
                            setPending(null);
                          };
                          void change({
                            transitionId: rule.transition_id,
                            statusId: value === '' ? null : value,
                          }).then(done, done);
                        }}
                      >
                        {statusOptions}
                      </Select>
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove ${label}`}
                          onClick={() => {
                            void reset(rule.transition_id).catch(
                              () => undefined
                            );
                          }}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {canEdit && (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={onAddBranchRule}
            >
              <Select
                aria-label="Event"
                className="w-40"
                value={newTrigger}
                onChange={(event) => {
                  setNewTrigger(event.target.value as TransitionTrigger);
                }}
              >
                {TRANSITION_TRIGGERS.map((trigger) => (
                  <option key={trigger} value={trigger}>
                    {TRIGGER_SHORT[trigger]}
                  </option>
                ))}
              </Select>
              <Input
                aria-label="Target branch"
                placeholder="main or release/*"
                className="w-44"
                maxLength={255}
                value={newPattern}
                onChange={(event) => {
                  setNewPattern(event.target.value);
                }}
              />
              <Select
                aria-label="Move the issue to"
                className="w-44"
                value={newStatus}
                onChange={(event) => {
                  setNewStatus(event.target.value);
                }}
              >
                {statusOptions}
              </Select>
              <Button
                type="submit"
                size="sm"
                disabled={newPattern.trim() === '' || pending === 'branch-new'}
              >
                Add branch rule
              </Button>
            </form>
          )}
        </div>
      )}
    </section>
  );
};

export default TransitionsSection;
