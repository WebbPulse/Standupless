/**
 * A team's triage settings. While triage is on, every new issue filed without
 * a status waits in the team's triage inbox instead of landing in its lists
 * and board, until a member accepts, declines, marks as duplicate or snoozes
 * it.
 *
 * Responsibility names the members on triage duty and what happens as an
 * issue enters the inbox: everyone on duty is notified, or one of them, round
 * robin, is assigned it. The priority rule holds an accept until the issue has
 * a priority. Each control is one choice, so it saves as soon as it changes.
 * The ordered rules below them run on every issue entering the inbox.
 *
 * Turning triage on needs a plan with triage, so on a plan without it the
 * switch only turns off and a note links to the plans; the server's refusal
 * stays the rule, as it does for who may hold duty.
 */

import React, { useId } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import { listTeamMembers } from '../../api/teams';
import { getTriageSettings, updateTriageSettings } from '../../api/triage';
import { listMembers } from '../../api/workspaces';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { personLabel } from '../../lib/issuePeople';
import {
  membersKey,
  teamMembersKey,
  triageSettingsKey,
  triageSummaryKey,
} from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import type {
  TriageResponsibilityAction,
  TriageRuleBody,
  TriageSettingsUpdate,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Checkbox from '../ui/checkbox';
import { SelectField } from '../ui/select';
import Spinner from '../ui/spinner';
import PlanRequiredNote from './PlanRequiredNote';
import TriageRulesSection from './TriageRulesSection';

/** Props for TriageSection: which team, and whether the caller may edit. */
export interface TriageSectionProps {
  workspaceId: string;
  teamId: string;
  /** Whether the caller administers the team. */
  canEdit: boolean;
  /** Whether the workspace's plan includes triage; true when unknown. */
  planIncluded?: boolean;
  /** The workspace slug, for the link to the plans. */
  slug?: string;
}

/** How often the settings are re-read while the settings tab is open. */
const POLL_MS = 60000;

/** Props for Toggle: its state, its label's id and whether it may flip. */
interface ToggleProps {
  checked: boolean;
  labelledBy: string;
  disabled: boolean;
  onFlip: () => void;
}

/** The settings switch, drawn to match the other team settings. */
const Toggle: React.FC<ToggleProps> = ({
  checked,
  labelledBy,
  disabled,
  onFlip,
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-labelledby={labelledBy}
    disabled={disabled}
    onClick={onFlip}
    className={cn(
      'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-transparent transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60',
      checked
        ? 'bg-accent enabled:hover:bg-accent-strong'
        : 'bg-line-strong enabled:hover:bg-text-faint'
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

/** Shows and changes a team's triage settings. */
export const TriageSection: React.FC<TriageSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
  planIncluded = true,
  slug = '',
}) => {
  const auth = useQueryAuth();
  const labelId = useId();
  const priorityLabelId = useId();
  const queryKey = triageSettingsKey(workspaceId, teamId);

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => getTriageSettings(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const { data: teamMembers } = usePolledQuery(
    (context) => listTeamMembers(workspaceId, teamId, context),
    { intervalMs: POLL_MS, queryKey: teamMembersKey(teamId), auth }
  );

  const { data: workspaceMembers } = usePolledQuery(
    (context) => listMembers(workspaceId, context),
    {
      intervalMs: POLL_MS,
      enabled: canEdit,
      queryKey: membersKey(workspaceId),
      auth,
    }
  );

  const {
    mutate: save,
    error: saveError,
    isMutating: saving,
  } = useMutationWithRefetch(
    (body: TriageSettingsUpdate) =>
      updateTriageSettings(workspaceId, teamId, body),
    [queryKey, triageSummaryKey(workspaceId)]
  );

  const enabled = data?.enabled ?? false;
  const locked = !planIncluded && !enabled;
  const onDuty = data?.responsible_user_ids ?? [];
  const action = data?.responsibility_action ?? 'notify';
  const requirePriority = data?.require_priority ?? false;

  const guests = new Set(
    (workspaceMembers ?? [])
      .filter((member) => member.role === 'guest')
      .map((member) => member.user_id)
  );
  const candidates = (teamMembers ?? []).filter(
    (member) => !guests.has(member.user_id)
  );
  const strays = onDuty.filter(
    (userId) => !candidates.some((member) => member.user_id === userId)
  );

  const apply = async (
    body: TriageSettingsUpdate,
    done: string
  ): Promise<void> => {
    if (!canEdit || saving) return;
    try {
      await save(body);
      await refetch();
      showToast(done);
    } catch {
      return;
    }
  };

  const onFlip = (): void => {
    if (locked) return;
    void apply(
      { enabled: !enabled },
      enabled ? 'Triage turned off.' : 'Triage turned on.'
    );
  };

  const onPick = (userId: string, picked: boolean): void => {
    const next = picked
      ? [...onDuty, userId]
      : onDuty.filter((id) => id !== userId);
    void apply({ responsible_user_ids: next }, 'Triage duty saved.');
  };

  const onAction = (next: TriageResponsibilityAction): void => {
    void apply(
      { responsibility_action: next },
      next === 'assign'
        ? 'New triage issues will be assigned round robin.'
        : 'Everyone on triage duty will be notified.'
    );
  };

  const onRules = async (
    rules: TriageRuleBody[],
    done: string
  ): Promise<void> => {
    await save({ rules });
    await refetch();
    showToast(done);
  };

  const onPriority = (): void => {
    void apply(
      { require_priority: !requirePriority },
      requirePriority
        ? 'Priority is no longer required.'
        : 'Priority is now required before leaving triage.'
    );
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Triage</h3>
        <p className="text-sm text-text-muted">
          New issues wait in a triage inbox until a member accepts, declines,
          marks them as a duplicate or snoozes them. This includes issues filed
          by team members, who can pick a status when filing to skip it.
        </p>
      </div>

      {!planIncluded && (
        <PlanRequiredNote feature="triage" name="Triage" slug={slug} />
      )}

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
        <ul className="divide-y divide-line rounded-md border border-line">
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
            <Toggle
              checked={enabled}
              labelledBy={labelId}
              disabled={!canEdit || saving || locked}
              onFlip={onFlip}
            />
          </li>
          {enabled && (
            <li className="space-y-3 px-3 py-3">
              <div className="min-w-0">
                <span className="block text-sm font-medium text-text">
                  Responsibility
                </span>
                <p className="text-xs text-text-muted">
                  Choose who handles issues as they enter triage, and whether
                  they are notified or one of them is assigned in turn.
                </p>
              </div>
              <SelectField
                id={`${labelId}-action`}
                label="When an issue enters triage"
                className="max-w-xs"
                value={action}
                disabled={!canEdit || saving}
                onChange={(event) => {
                  onAction(event.target.value as TriageResponsibilityAction);
                }}
              >
                <option value="notify">Notify everyone on duty</option>
                <option value="assign">Assign round robin</option>
              </SelectField>
              <fieldset className="space-y-1">
                <legend className="text-xs font-medium text-text-muted">
                  On triage duty
                </legend>
                {candidates.length === 0 && strays.length === 0 ? (
                  <p className="text-xs text-text-muted">
                    Add members to this team to put them on triage duty.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {candidates.map((member) => (
                      <Checkbox
                        key={member.user_id}
                        label={personLabel(member)}
                        checked={onDuty.includes(member.user_id)}
                        disabled={!canEdit || saving}
                        onChange={(event) => {
                          onPick(member.user_id, event.target.checked);
                        }}
                      />
                    ))}
                    {strays.map((userId) => (
                      <Checkbox
                        key={userId}
                        label="No longer on this team"
                        checked={true}
                        disabled={!canEdit || saving}
                        onChange={() => {
                          onPick(userId, false);
                        }}
                      />
                    ))}
                  </div>
                )}
              </fieldset>
            </li>
          )}
          {enabled && (
            <li className="flex min-h-row items-center justify-between gap-4 px-3 py-2">
              <div className="min-w-0">
                <span
                  id={priorityLabelId}
                  className="block text-sm font-medium text-text"
                >
                  Require priority before leaving triage
                </span>
                <p className="text-xs text-text-muted">
                  Accepting an issue asks for a priority when it has none.
                </p>
              </div>
              <Toggle
                checked={requirePriority}
                labelledBy={priorityLabelId}
                disabled={!canEdit || saving}
                onFlip={onPriority}
              />
            </li>
          )}
          {enabled && (
            <li className="px-3 py-3">
              <TriageRulesSection
                workspaceId={workspaceId}
                teamId={teamId}
                canEdit={canEdit}
                rules={data?.rules ?? []}
                assignees={candidates}
                creators={workspaceMembers ?? teamMembers ?? []}
                saving={saving}
                onSave={onRules}
              />
            </li>
          )}
        </ul>
      )}
    </section>
  );
};

export default TriageSection;
