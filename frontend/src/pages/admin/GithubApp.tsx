/**
 * The platform admin page that creates this environment's GitHub App.
 *
 * Creating one is GitHub's App manifest flow: the server builds the manifest
 * from this deployment's own URLs and signs a state, and the page posts both
 * to GitHub as a form, because GitHub only accepts the manifest as a posted
 * form field. GitHub then shows its own confirmation page and sends the
 * browser back to `/admin/github-app/created` with a one-time code.
 *
 * Anyone who is not a platform admin gets the ordinary not found page, the
 * same answer the API gives them.
 */

import React, { useEffect, useRef, useState } from 'react';
import { getGithubAppStatus, startGithubApp } from '../../api/admin';
import AccountShell from '../../components/layout/AccountShell';
import { ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
import TextLink from '../../components/ui/link';
import Spinner from '../../components/ui/spinner';
import type {
  GithubAppManifestRead,
  GithubAppStatusRead,
} from '../../types/Api';
import NotFound from '../NotFound';
import { githubAppErrorMessage, isNotFound } from './githubAppErrors';

/** What the status read settled on. */
type Loaded =
  | { kind: 'loading' }
  | { kind: 'not_found' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; status: GithubAppStatusRead };

/**
 * Reads the status, offers Create GitHub App when the environment can take
 * one, and submits the manifest form to GitHub once the server has signed it.
 */
const GithubApp: React.FC = () => {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [start, setStart] = useState<GithubAppManifestRead | null>(null);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    getGithubAppStatus(controller.signal)
      .then((status) => {
        if (!controller.signal.aborted) setLoaded({ kind: 'ready', status });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded(
          isNotFound(error)
            ? { kind: 'not_found' }
            : {
                kind: 'failed',
                message: githubAppErrorMessage(
                  error,
                  'The GitHub App status could not be read. Reload to try again.'
                ),
              }
        );
      });
    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (start !== null) form.current?.submit();
  }, [start]);

  if (loaded.kind === 'loading') {
    return <Spinner label="Loading the GitHub App status" />;
  }

  if (loaded.kind === 'not_found') {
    return <NotFound />;
  }

  /** Asks the server for a signed manifest, which the effect above posts to GitHub. */
  const create = () => {
    setStarting(true);
    setStartError(null);
    startGithubApp()
      .then(setStart)
      .catch((error: unknown) => {
        setStarting(false);
        setStartError(
          githubAppErrorMessage(
            error,
            'The App creation could not be started. Try again.'
          )
        );
      });
  };

  return (
    <AccountShell width="narrow">
      <div className="space-y-5 rounded-lg border border-line bg-bg p-6">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">GitHub App</h1>
          <p className="text-sm text-text-muted">
            The App every workspace in this environment installs to connect
            GitHub.
          </p>
        </div>

        {loaded.kind === 'failed' && <ErrorAlert message={loaded.message} />}

        {loaded.kind === 'ready' && loaded.status.configured && (
          <p role="status" className="text-sm text-text">
            This environment already has a GitHub App. To replace it, remove its
            keys from the app secret first.
          </p>
        )}

        {loaded.kind === 'ready' &&
          !loaded.status.configured &&
          !loaded.status.secret_available && (
            <p role="status" className="text-sm text-text">
              This environment has no app secret to store the credentials in, so
              no App can be created here.
            </p>
          )}

        {loaded.kind === 'ready' &&
          !loaded.status.configured &&
          loaded.status.secret_available && (
            <div className="space-y-3">
              <p className="text-sm text-text-muted">
                Creates <strong>{loaded.status.app_name}</strong> under the{' '}
                {loaded.status.organization} organization with the permissions,
                events and URLs this environment needs. GitHub asks you to
                confirm, then sends you back here while its credentials go
                straight into the app secret.
              </p>
              {startError !== null && <ErrorAlert message={startError} />}
              <Button variant="primary" onClick={create} disabled={starting}>
                {starting ? 'Opening GitHub' : 'Create GitHub App'}
              </Button>
            </div>
          )}

        {start !== null && (
          <form
            ref={form}
            method="post"
            action={start.post_url}
            aria-hidden="true"
            className="hidden"
            data-testid="manifest-form"
          >
            <input
              type="hidden"
              name="manifest"
              value={JSON.stringify(start.manifest)}
            />
          </form>
        )}

        <p className="text-sm text-text-muted">
          <TextLink to="/workspaces">Back to your workspaces</TextLink>
        </p>
      </div>
    </AccountShell>
  );
};

export default GithubApp;
