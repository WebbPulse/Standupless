/**
 * Creates a workspace and opens it. The picker sends someone here when they
 * belong to no workspace yet, and links here for anyone who wants another.
 */

import React, { useState } from 'react';
import { useMutationWithRefetch } from '@webbpulse/api-client/react';
import { useNavigate } from 'react-router-dom';
import { createWorkspace } from '../../api/workspaces';
import AccountShell from '../../components/layout/AccountShell';
import { ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
import Field from '../../components/ui/field';
import TextLink from '../../components/ui/link';
import { Logo } from '../../brand';
import { errorMessage } from '../../lib/errors';
import { ALL_WORKSPACES_PATH, workspacePath } from '../../lib/paths';
import { WORKSPACES_KEY } from '../../lib/queryKeys';
import { slugFromName, validateSlug } from '../../lib/validation';

/** The form that names a new workspace and picks its URL. */
const CreateWorkspace: React.FC = () => {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);

  const {
    mutate: create,
    isMutating,
    error: createError,
  } = useMutationWithRefetch(
    (body: { name: string; slug: string }) => createWorkspace(body),
    WORKSPACES_KEY
  );

  const slugError = slug === '' ? null : validateSlug(slug);
  const canSubmit =
    name.trim() !== '' && slug !== '' && slugError === null && !isMutating;

  const onNameChange = (value: string): void => {
    setName(value);
    if (!slugTouched) setSlug(slugFromName(value));
  };

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    void create({ name: name.trim(), slug })
      .then((workspace) => {
        void navigate(workspacePath(workspace.slug), { replace: true });
      })
      .catch(() => undefined);
  };

  const host = typeof window === 'undefined' ? '' : window.location.host;

  return (
    <AccountShell>
      <div className="mx-auto flex max-w-sm flex-col gap-6 pt-6 sm:pt-12">
        <header className="flex flex-col items-center gap-3 text-center">
          <Logo size={36} title={null} />
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">
              Create a workspace
            </h1>
            <p className="text-sm text-text-muted">
              A workspace holds your teams, their issues, cycles and projects.
            </p>
          </div>
        </header>

        <form
          className="space-y-4 rounded-md border border-line bg-surface p-5 shadow-sm"
          onSubmit={onSubmit}
        >
          {createError !== null && (
            <ErrorAlert
              message={errorMessage(
                createError,
                'Could not create the workspace.'
              )}
            />
          )}

          <Field
            id="workspace-name"
            label="Workspace name"
            value={name}
            autoComplete="off"
            autoFocus
            placeholder="Acme"
            onChange={(event) => {
              onNameChange(event.target.value);
            }}
          />
          <div className="space-y-1">
            <Field
              id="workspace-slug"
              label="Workspace URL"
              value={slug}
              autoComplete="off"
              aria-describedby="workspace-slug-help"
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(event.target.value);
              }}
            />
            <p
              id="workspace-slug-help"
              className={
                slugError === null
                  ? 'truncate text-xs text-text-faint'
                  : 'text-xs text-danger'
              }
            >
              {slugError ??
                `${host}${workspacePath(slug === '' ? 'acme' : slug)}`}
            </p>
          </div>
          <Button
            type="submit"
            variant="primary"
            disabled={!canSubmit}
            className="w-full"
          >
            {isMutating ? 'Creating' : 'Create workspace'}
          </Button>
        </form>

        <p className="text-center text-xs text-text-faint">
          <TextLink to={ALL_WORKSPACES_PATH}>Back to your workspaces</TextLink>
        </p>
      </div>
    </AccountShell>
  );
};

export default CreateWorkspace;
