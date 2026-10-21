/**
 * The sign-in email and changing it. Nothing changes until the person opens
 * the link mailed to the new address, so the form only ever sends that link,
 * and the old address hears about the change once it is made. A sign-in older
 * than the server's window is asked to prove it is still them first, through
 * the same step-up prompt the connected accounts use, and the request is sent
 * again once they have.
 */

import React, { useId, useMemo, useState } from 'react';
import { StepUpRequiredError } from '@webbpulse/api-client';
import {
  StepUpCancelledError,
  type EmailChangeRequestOutcome,
} from '@webbpulse/auth';
import { useStepUp } from '@webbpulse/auth/react';
import {
  getIdentityClient,
  type IdentityClient,
} from '../../api/identityClient';
import StepUpDialog from '../auth/StepUpDialog';
import { useAuth } from '../../hooks/useAuth';
import { EMAIL_CHANGE_REFUSALS } from '../../lib/account';
import { errorMessage } from '../../lib/errors';
import { ConfirmationAlert, ErrorAlert } from '../ui/alert';
import Badge from '../ui/badge';
import Button from '../ui/button';
import Field from '../ui/field';

/**
 * Turns a `step-up-required` outcome into the rejection the step-up gate
 * answers with its prompt, so a confirmed step-up replays the request.
 */
const requestOrChallenge = async (
  client: IdentityClient,
  email: string
): Promise<EmailChangeRequestOutcome> => {
  const outcome = await client.requestEmailChange({ email });
  if (!outcome.ok && outcome.reason === 'step-up-required') {
    throw new StepUpRequiredError({
      status: 401,
      statusText: 'Unauthorized',
      body: { error_code: 'STEP_UP_REQUIRED', message: outcome.message },
      url: '',
      method: 'POST',
      maxAge: outcome.maxAge,
    });
  }
  return outcome;
};

/** The form, mounted only once a client exists. */
const EmailChangeForm: React.FC<{ client: IdentityClient }> = ({ client }) => {
  const { user } = useAuth();
  const gate = useStepUp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const fieldId = useId();

  const { withStepUp } = gate;
  const request = useMemo(
    () => withStepUp((email: string) => requestOrChallenge(client, email)),
    [client, withStepUp]
  );

  if (user === null) return null;

  const close = (): void => {
    setEditing(false);
    setDraft('');
    setError(null);
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const email = draft.trim();
    if (email === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await request(email);
      if (outcome.ok) {
        setSentTo(email);
        close();
        return;
      }
      setError(
        outcome.message === ''
          ? (EMAIL_CHANGE_REFUSALS[outcome.reason] ??
              'Could not send a confirmation link.')
          : outcome.message
      );
    } catch (failure) {
      if (!(failure instanceof StepUpCancelledError)) {
        setError(errorMessage(failure, 'Could not send a confirmation link.'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4" aria-labelledby="email-title">
      <div className="space-y-1">
        <h2 id="email-title" className="text-base font-semibold">
          Email
        </h2>
        <p className="text-sm text-text-muted">
          The address you sign in with and where notifications are sent.
        </p>
      </div>
      <div className="space-y-3 rounded-md border border-line p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="truncate text-sm font-medium text-text"
              data-testid="sign-in-email"
            >
              {user.email}
            </span>
            <Badge tone={user.email_verified ? 'success' : 'warning'}>
              {user.email_verified ? 'Verified' : 'Not verified'}
            </Badge>
          </div>
          {!editing && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSentTo(null);
                setEditing(true);
              }}
            >
              Change email
            </Button>
          )}
        </div>
        {editing && (
          <form className="space-y-3" onSubmit={(event) => void submit(event)}>
            <Field
              id={fieldId}
              label="New email"
              type="email"
              autoComplete="email"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              hint="We send a link to the new address. Your sign-in email changes once you open it."
              disabled={busy}
              autoFocus
            />
            <ErrorAlert message={error} />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={close}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={busy || draft.trim() === ''}
              >
                Send link
              </Button>
            </div>
          </form>
        )}
        <ConfirmationAlert
          message={
            sentTo === null
              ? null
              : `Check ${sentTo} for a link to confirm the change. Until you open it, you keep signing in with your current email.`
          }
        />
      </div>
      <StepUpDialog gate={gate} action="change your email" reauth={[]} />
    </section>
  );
};

/** Renders the email section, or nothing when no identity client could be built. */
const EmailSection: React.FC = () => {
  const client = getIdentityClient();
  if (client === null) return null;
  return <EmailChangeForm client={client} />;
};

export default EmailSection;
