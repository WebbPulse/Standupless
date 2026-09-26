/**
 * The slim "in development" notice across the top of the signed in app. It
 * greets every new session: dismissing it hides it for the rest of that
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
      className="flex shrink-0 items-center gap-2.5 border-b border-accent/30 bg-accent-soft px-4 py-1.5 text-xs text-text"
    >
      <LuWrench
        className="h-3.5 w-3.5 shrink-0 text-accent"
        aria-hidden="true"
      />
      <p className="min-w-0 flex-1">
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
        className="-mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-raised hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
      >
        <LuX className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
};

export default DevelopmentBanner;
