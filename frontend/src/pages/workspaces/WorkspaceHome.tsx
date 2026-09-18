/**
 * The workspace home page: every project the caller can see in this workspace,
 * plus the form that creates one.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import { Link } from 'react-router-dom';
import { createProject, listProjects } from '../../api/projects';
import { ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
import Field from '../../components/ui/field';
import { SelectField } from '../../components/ui/select';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canCreateProject } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { projectsKey } from '../../lib/queryKeys';
import { keyPrefixFromName, validateKeyPrefix } from '../../lib/validation';
import type { EstimateScale } from '../../types/Api';

/** How often the project list is re-read while this page is open. */
const POLL_MS = 60000;

/** The estimate scales the contract allows, with their interface wording. */
const ESTIMATE_SCALES: { value: EstimateScale; label: string }[] = [
  { value: 'off', label: 'No estimates' },
  { value: 'fibonacci', label: 'Fibonacci' },
  { value: 'linear', label: 'Linear' },
  { value: 'tshirt', label: 'T-shirt sizes' },
];

/** Lists this workspace's projects and creates new ones. */
const WorkspaceHome: React.FC = () => {
  const { workspace } = useWorkspace();
  const auth = useQueryAuth();
  const [name, setName] = useState('');
  const [keyPrefix, setKeyPrefix] = useState('');
  const [prefixTouched, setPrefixTouched] = useState(false);
  const [estimateScale, setEstimateScale] = useState<EstimateScale>('off');

  const workspaceId = workspace?.id ?? '';
  const queryKey = projectsKey(workspaceId);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listProjects(workspaceId, signal),
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
    }) => createProject(workspaceId, body),
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
    <WorkspaceShell>
      <section className="space-y-4">
        <h2 className="text-lg font-medium text-white">Projects</h2>

        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load the projects.')}
          />
        )}

        {isLoading || data === null ? (
          <Spinner label="Loading projects" />
        ) : data.length === 0 ? (
          <p className="text-sm text-slate-400">
            This workspace has no projects yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {data.map((project) => (
              <li
                key={project.id}
                className="rounded-md border border-slate-700 px-3 py-2"
              >
                <Link
                  to={`/w/${workspace?.slug ?? ''}/p/${project.key_prefix}`}
                  className="flex items-center justify-between gap-3 text-sm text-slate-100 hover:text-sky-300"
                >
                  <span className="font-medium">{project.name}</span>
                  <span className="text-xs text-slate-500">
                    {project.key_prefix}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canCreateProject(workspace?.role) && (
        <section className="space-y-4 rounded-md border border-slate-700 p-4">
          <h2 className="text-lg font-medium text-white">Create a project</h2>

          {createError !== null && (
            <ErrorAlert
              message={errorMessage(
                createError,
                'Could not create the project.'
              )}
            />
          )}

          <form className="space-y-4" onSubmit={onSubmit}>
            <Field
              id="project-name"
              label="Name"
              value={name}
              autoComplete="off"
              onChange={(event) => {
                onNameChange(event.target.value);
              }}
            />

            <div className="space-y-1">
              <Field
                id="project-key-prefix"
                label="Key prefix"
                value={keyPrefix}
                autoComplete="off"
                aria-describedby="project-key-prefix-help"
                onChange={(event) => {
                  setPrefixTouched(true);
                  setKeyPrefix(event.target.value.toUpperCase());
                }}
              />
              <p
                id="project-key-prefix-help"
                className={
                  prefixError === null
                    ? 'text-xs text-slate-500'
                    : 'text-xs text-red-300'
                }
              >
                {prefixError ??
                  'Uppercase letters and numbers, 2 to 6 characters, starting with a letter. Issue keys read like ENG-14.'}
              </p>
            </div>

            <SelectField
              id="project-estimate-scale"
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

            <Button type="submit" disabled={!canSubmit}>
              {isMutating ? 'Creating' : 'Create project'}
            </Button>
          </form>
        </section>
      )}
    </WorkspaceShell>
  );
};

export default WorkspaceHome;
