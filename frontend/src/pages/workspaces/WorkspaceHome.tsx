/**
 * The workspace home page: every team the caller can see in this workspace,
 * plus the form that creates one.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import { LuChevronRight, LuFolder } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { createTeam, listTeams } from '../../api/teams';
import { ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
import EmptyState from '../../components/ui/empty-state';
import Field from '../../components/ui/field';
import { SelectField } from '../../components/ui/select';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canCreateTeam } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { teamsKey } from '../../lib/queryKeys';
import { keyPrefixFromName, validateKeyPrefix } from '../../lib/validation';
import type { EstimateScale } from '../../types/Api';

/** How often the team list is re-read while this page is open. */
const POLL_MS = 60000;

/** The estimate scales the contract allows, with their interface wording. */
const ESTIMATE_SCALES: { value: EstimateScale; label: string }[] = [
  { value: 'off', label: 'No estimates' },
  { value: 'fibonacci', label: 'Fibonacci' },
  { value: 'linear', label: 'Linear' },
  { value: 'tshirt', label: 'T-shirt sizes' },
];

/** Lists this workspace's teams and creates new ones. */
const WorkspaceHome: React.FC = () => {
  const { workspace } = useWorkspace();
  const auth = useQueryAuth();
  const [name, setName] = useState('');
  const [keyPrefix, setKeyPrefix] = useState('');
  const [prefixTouched, setPrefixTouched] = useState(false);
  const [estimateScale, setEstimateScale] = useState<EstimateScale>('off');

  const workspaceId = workspace?.id ?? '';
  const queryKey = teamsKey(workspaceId);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listTeams(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey,
      auth,
    }
  );

  const {
    mutate: create,
    isMutating,
    error: createError,
  } = useMutationWithRefetch(
    (body: {
      name: string;
      key_prefix: string;
      estimate_scale: EstimateScale;
    }) => createTeam(workspaceId, body),
    queryKey
  );

  const prefixError = validateKeyPrefix(keyPrefix);
  const canSubmit =
    name.trim() !== '' &&
    keyPrefix !== '' &&
    prefixError === null &&
    !isMutating;

  const onNameChange = (value: string): void => {
    setName(value);
    if (!prefixTouched) setKeyPrefix(keyPrefixFromName(value));
  };

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    void create({
      name: name.trim(),
      key_prefix: keyPrefix,
      estimate_scale: estimateScale,
    })
      .then(() => {
        setName('');
        setKeyPrefix('');
        setPrefixTouched(false);
        setEstimateScale('off');
      })
      .catch(() => undefined);
  };

  return (
    <WorkspaceShell title="Teams">
      <div className="space-y-6">
        <section className="space-y-3">
          {error !== null && (
            <ErrorAlert
              message={errorMessage(error, 'Could not load the teams.')}
            />
          )}

          {isLoading || data === null ? (
            <Spinner label="Loading teams" />
          ) : data.length === 0 ? (
            <EmptyState
              icon={<LuFolder />}
              message="This workspace has no teams yet."
            />
          ) : (
            <ul className="rounded-md border border-line">
              {data.map((team) => (
                <li
                  key={team.id}
                  className="border-b border-line last:border-b-0"
                >
                  <Link
                    to={`/w/${workspace?.slug ?? ''}/team/${team.key_prefix}`}
                    className="flex h-row items-center gap-3 px-3 text-sm text-text transition-colors duration-100 hover:bg-surface"
                  >
                    <span
                      aria-hidden="true"
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-raised text-text-muted"
                    >
                      <LuFolder className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {team.name}
                    </span>
                    <span className="font-mono text-xs text-text-faint">
                      {team.key_prefix}
                    </span>
                    <LuChevronRight
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-text-faint"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {canCreateTeam(workspace?.role) && (
          <section className="space-y-4 rounded-md border border-line p-4">
            <div>
              <h2 className="text-base font-semibold">Create a team</h2>
              <p className="text-sm text-text-muted">
                Issues in a team take its key prefix, so pick one that reads
                well in a sentence.
              </p>
            </div>

            {createError !== null && (
              <ErrorAlert
                message={errorMessage(
                  createError,
                  'Could not create the team.'
                )}
              />
            )}

            <form className="max-w-md space-y-4" onSubmit={onSubmit}>
              <Field
                id="team-name"
                label="Name"
                value={name}
                autoComplete="off"
                onChange={(event) => {
                  onNameChange(event.target.value);
                }}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Field
                    id="team-key-prefix"
                    label="Key prefix"
                    value={keyPrefix}
                    autoComplete="off"
                    aria-describedby="team-key-prefix-help"
                    onChange={(event) => {
                      setPrefixTouched(true);
                      setKeyPrefix(event.target.value.toUpperCase());
                    }}
                  />
                  <p
                    id="team-key-prefix-help"
                    className={cn(
                      'text-xs',
                      prefixError === null ? 'text-text-faint' : 'text-danger'
                    )}
                  >
                    {prefixError ??
                      'Uppercase letters and numbers, 2 to 6 characters, starting with a letter. Issue keys read like ENG-14.'}
                  </p>
                </div>

                <SelectField
                  id="team-estimate-scale"
                  label="Estimate scale"
                  value={estimateScale}
                  onChange={(event) => {
                    setEstimateScale(event.target.value as EstimateScale);
                  }}
                >
                  {ESTIMATE_SCALES.map((scale) => (
                    <option key={scale.value} value={scale.value}>
                      {scale.label}
                    </option>
                  ))}
                </SelectField>
              </div>

              <Button type="submit" variant="primary" disabled={!canSubmit}>
                {isMutating ? 'Creating' : 'Create team'}
              </Button>
            </form>
          </section>
        )}
      </div>
    </WorkspaceShell>
  );
};

export default WorkspaceHome;
