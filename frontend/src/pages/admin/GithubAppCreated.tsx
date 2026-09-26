/**
 * Where GitHub sends a platform admin back after creating the App.
 *
 * The page posts GitHub's one-time `code` and the signed `state` to the API,
 * which checks the state was minted for this admin, exchanges the code, and
 * writes the App's key, client secret and webhook secret into the app secret
 * without answering them. What comes back, and what this page shows, is only
 * the App's id and slug, then the settings GitHub has no API for.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { convertGithubApp } from '../../api/admin';
import AccountShell from '../../components/layout/AccountShell';
import { ErrorAlert } from '../../components/ui/alert';
import TextLink from '../../components/ui/link';
import Spinner from '../../components/ui/spinner';
import type { GithubAppCreatedRead } from '../../types/Api';
import NotFound from '../NotFound';
import { githubAppErrorMessage, isNotFound } from './githubAppErrors';

/** What the exchange settled on. */
type Exchange =
  | { kind: 'exchanging' }
  | { kind: 'not_found' }
  | { kind: 'failed'; message: string }
  | { kind: 'created'; app: GithubAppCreatedRead };

/** The steps GitHub has no API for, against the App that was just created. */
const FinishSetup: React.FC<{ app: GithubAppCreatedRead }> = ({ app }) => (
  <section className="space-y-3" aria-labelledby="finish-setup">
    <h2 id="finish-setup" className="text-sm font-semibold">
      Finish setup
    </h2>
    <ol className="list-decimal space-y-2 pl-5 text-sm text-text">
      <li>
        <a
          className="text-accent underline-offset-2 hover:underline"
          href={app.logo_path}
          download="standupless-github-app-logo.png"
        >
          Download the logo
        </a>
        .
      </li>
      <li>
        Open the{' '}
        <a
          className="text-accent underline-offset-2 hover:underline"
          href={app.settings_url}
          target="_blank"
          rel="noreferrer"
        >
          App&apos;s settings on GitHub
        </a>
        . Under Display information, upload the logo and set the badge
        background color to{' '}
        <span className="inline-flex items-center gap-1.5 font-mono">
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 rounded-xs border border-line"
            style={{ backgroundColor: app.badge_color }}
          />
          {app.badge_color}
        </span>
        .
      </li>
      <li>
        If this environment&apos;s <code>github_app_slug</code> Terraform
        variable is not already <code>{app.slug}</code>, set it and apply, so
        Connect GitHub sends workspace admins to this App.
      </li>
    </ol>
  </section>
);

/** Exchanges the code once, then shows the App and the remaining steps. */
const GithubAppCreated: React.FC = () => {
  const [params] = useSearchParams();
  const code = params.get('code');
  const state = params.get('state');
  const attempted = useRef(false);
  const [exchange, setExchange] = useState<Exchange>({ kind: 'exchanging' });

  useEffect(() => {
    if (code === null || state === null || attempted.current) return;
    attempted.current = true;
    convertGithubApp({ code, state })
      .then((app) => {
        setExchange({ kind: 'created', app });
      })
      .catch((error: unknown) => {
        setExchange(
          isNotFound(error)
            ? { kind: 'not_found' }
            : {
                kind: 'failed',
                message: githubAppErrorMessage(
                  error,
                  'The App could not be finished. Start again from the GitHub App page.'
                ),
              }
        );
      });
  }, [code, state]);

  if (exchange.kind === 'not_found') {
    return <NotFound />;
  }

  const missing = code === null || state === null;

  return (
    <AccountShell width="narrow">
      <div className="space-y-5 rounded-lg border border-line bg-bg p-6">
        <h1 className="text-lg font-semibold">GitHub App</h1>

        {missing && (
          <ErrorAlert message="This link is missing the code GitHub sends back. Start again from the GitHub App page." />
        )}

        {!missing && exchange.kind === 'exchanging' && (
          <Spinner label="Storing the App's credentials" />
        )}

        {exchange.kind === 'failed' && (
          <ErrorAlert message={exchange.message} />
        )}

        {exchange.kind === 'created' && (
          <>
            <dl
              role="status"
              className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm"
            >
              <dt className="text-text-muted">Slug</dt>
              <dd className="font-mono">{exchange.app.slug}</dd>
              <dt className="text-text-muted">App ID</dt>
              <dd className="font-mono">{exchange.app.id}</dd>
            </dl>
            <p className="text-sm text-text-muted">
              The App is created and its credentials are in the app secret.
            </p>
            <FinishSetup app={exchange.app} />
          </>
        )}

        <p className="text-sm text-text-muted">
          <TextLink to="/admin/github-app">
            Back to the GitHub App page
          </TextLink>
        </p>
      </div>
    </AccountShell>
  );
};

export default GithubAppCreated;
