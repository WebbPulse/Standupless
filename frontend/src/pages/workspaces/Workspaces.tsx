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
import { LuBoxes, LuChevronRight } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { createWorkspace, listWorkspaces } from '../../api/workspaces';
import AccountShell from '../../components/layout/AccountShell';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import Button from '../../components/ui/button';
import EmptyState from '../../components/ui/empty-state';
import Field from '../../components/ui/field';
import Spinner from '../../components/ui/spinner';
import { WORKSPACES_KEY } from '../../lib/queryKeys';
import { errorMessage } from '../../lib/errors';
import { slugFromName, validateSlug } from '../../lib/validation';

/** How often the workspace list is re-read while this page is open. */
const POLL_MS = 60000;

/** Lists the caller's workspaces and creates new ones. */
const Workspaces: React.FC = () => {
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
    <AccountShell>
      <div className="space-y-8">
        <header className="flex items-center justify-between gap-4">
          <h1 className="text-xl font-semibold">Workspaces</h1>
        </header>

        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load your workspaces.')}
          />
        )}

        {isLoading || workspaces === null ? (
          <Spinner label="Loading workspaces" />
        ) : workspaces.length === 0 ? (
          <EmptyState
            icon={<LuBoxes />}
            message="You are not a member of any workspace yet. Create one below."
          />
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {workspaces.map((workspace) => (
              <li key={workspace.id}>
                <Link
                  to={`/w/${workspace.slug}`}
                  className="flex h-11 items-center gap-3 px-3 text-sm transition-colors duration-100 hover:bg-surface"
                >
                  <Avatar
                    name={workspace.name}
                    size="md"
                    className="rounded-sm"
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {workspace.name}
                  </span>
                  <span className="font-mono text-xs text-text-faint">
                    {workspace.slug}
                  </span>
                  <LuChevronRight
                    className="h-4 w-4 text-text-faint"
                    aria-hidden="true"
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}

        <section className="space-y-4 rounded-md border border-line bg-surface p-4">
          <h2 className="text-base font-semibold">Create a workspace</h2>

          {createError !== null && (
            <ErrorAlert
              message={errorMessage(
                createError,
                'Could not create the workspace.'
              )}
            />
          )}

          <form className="space-y-4" onSubmit={onSubmit}>
            <div className="grid gap-4 sm:grid-cols-2">
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
                      ? 'text-xs text-text-faint'
                      : 'text-xs text-danger'
                  }
                >
                  {slugError ??
                    'Lowercase letters, numbers and hyphens, 3 to 40 characters.'}
                </p>
              </div>
            </div>
            <Button type="submit" variant="primary" disabled={!canSubmit}>
              {isMutating ? 'Creating' : 'Create workspace'}
            </Button>
          </form>
        </section>
      </div>
    </AccountShell>
  );
};

export default Workspaces;
