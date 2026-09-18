/**
 * The authenticated landing page: every workspace the signed in user belongs
 * to, plus the form that creates one.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import { Link } from 'react-router-dom';
import { createWorkspace, listWorkspaces } from '../../api/workspaces';
import { ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
import Field from '../../components/ui/field';
import Spinner from '../../components/ui/spinner';
import { WORKSPACES_KEY } from '../../lib/queryKeys';
import { useAuth } from '../../hooks/useAuth';
import { errorMessage } from '../../lib/errors';
import { slugFromName, validateSlug } from '../../lib/validation';

/** How often the workspace list is re-read while this page is open. */
const POLL_MS = 60000;

/** Lists the caller's workspaces and creates new ones. */
const Workspaces: React.FC = () => {
  const { user, logout } = useAuth();
  const auth = useQueryAuth();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listWorkspaces(signal),
    {
      intervalMs: POLL_MS,
      queryKey: WORKSPACES_KEY,
      auth,
    }
  );

  const {
    mutate: create,
    isMutating,
    error: createError,
  } = useMutationWithRefetch(
    (body: { name: string; slug: string }) => createWorkspace(body),
    WORKSPACES_KEY
  );

  const slugError = validateSlug(slug);
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
      .then(() => {
        setName('');
        setSlug('');
        setSlugTouched(false);
      })
      .catch(() => undefined);
  };

  const workspaces = data;

  return (
    <main className="mx-auto max-w-2xl space-y-8 px-4 py-12">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-white">Workspaces</h1>
        <Button variant="secondary" onClick={() => void logout()}>
          Sign out
        </Button>
      </header>

      {user !== null && (
        <p className="text-sm text-slate-400">Signed in as {user.email}.</p>
      )}

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load your workspaces.')}
        />
      )}

      {isLoading || workspaces === null ? (
        <Spinner label="Loading workspaces" />
      ) : workspaces.length === 0 ? (
        <p className="text-sm text-slate-400">
          You are not a member of any workspace yet. Create one below.
        </p>
      ) : (
        <ul className="space-y-2">
          {workspaces.map((workspace) => (
            <li
              key={workspace.id}
              className="rounded-md border border-slate-700 px-3 py-2"
            >
              <Link
                to={`/w/${workspace.slug}`}
                className="flex items-center justify-between gap-3 text-sm text-slate-100 hover:text-sky-300"
              >
                <span className="font-medium">{workspace.name}</span>
                <span className="text-xs text-slate-500">{workspace.slug}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <section className="space-y-4 rounded-md border border-slate-700 p-4">
        <h2 className="text-lg font-medium text-white">Create a workspace</h2>

        {createError !== null && (
          <ErrorAlert
            message={errorMessage(
              createError,
              'Could not create the workspace.'
            )}
          />
        )}

        <form className="space-y-4" onSubmit={onSubmit}>
          <Field
            id="workspace-name"
            label="Name"
            value={name}
            autoComplete="off"
            onChange={(event) => {
              onNameChange(event.target.value);
            }}
          />

          <div className="space-y-1">
            <Field
              id="workspace-slug"
              label="Slug"
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
                  ? 'text-xs text-slate-500'
                  : 'text-xs text-red-300'
              }
            >
              {slugError ??
                'Lowercase letters, numbers and hyphens, 3 to 40 characters.'}
            </p>
          </div>

          <Button type="submit" disabled={!canSubmit}>
            {isMutating ? 'Creating' : 'Create workspace'}
          </Button>
        </form>
      </section>

      <p className="text-sm text-slate-400">
        <Link to="/security" className="text-sky-400 hover:text-sky-300">
          Security settings
        </Link>
      </p>
    </main>
  );
};

export default Workspaces;
