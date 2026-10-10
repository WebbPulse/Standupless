/**
 * The thin "in development" strip across the top of the signed in app, one
 * line tall so it stays visible without taking a row of the page. It greets
 * every new session: dismissing it hides it for the rest of that
 * session, and the next sign-in shows it again.
 */

import React from 'react';
import { LuWrench, LuX } from 'react-icons/lu';
import { useDismissedUntilSignIn } from '@webbpulse/auth/react';
import { LEGAL_CONTACT_EMAIL } from '../../lib/legal';

/** The key the dismissal is stored under. */
const BANNER_KEY = 'standupless.dev-banner';

/** The notice itself, or nothing once dismissed for this session. */
export const DevelopmentBanner: React.FC = () => {
  const { dismissed, dismiss } = useDismissedUntilSignIn(BANNER_KEY);

  if (dismissed) {
    return null;
  }

  return (
    <div
      role="status"
      data-testid="development-banner"
      className="flex min-h-6 shrink-0 items-center gap-2 border-b border-accent/30 bg-accent-soft px-3 text-2xs text-text"
    >
      <LuWrench className="h-3 w-3 shrink-0 text-accent" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate">
        Standupless is in development. Expect rough edges, and send feedback or
        problems to{' '}
        <a
          href={`mailto:${LEGAL_CONTACT_EMAIL}`}
          className="rounded-xs font-medium text-accent underline-offset-2 hover:underline"
        >
          {LEGAL_CONTACT_EMAIL}
        </a>
        .
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss notice"
        className="-mr-1 inline-flex h-5 w-5 pointer-coarse:h-9 pointer-coarse:w-9 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-raised hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
      >
        <LuX className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  );
};

export default DevelopmentBanner;
