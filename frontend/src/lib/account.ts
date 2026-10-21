/**
 * The wording and rules the personal account settings share: the shape a
 * username takes, the sentences for a refused email change, and how a session's
 * device and sign-in methods read.
 */

/** The shape a username takes, which is the shape the mention parser reads. */
export const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;

/** The sentence for each refusal, used when the server sent none of its own. */
export const EMAIL_CHANGE_REFUSALS: Record<string, string> = {
  'invalid-email': 'Enter a valid email address.',
  unchanged: 'That is already your sign-in email.',
  taken: 'Another account already signs in with that address.',
  unavailable:
    'Email is not configured for this deployment, so the address cannot be changed.',
  'rate-limited': 'Too many attempts. Wait a few minutes, then try again.',
};

/** How each device class reads. */
const DEVICE_LABELS: Record<string, string> = {
  desktop: 'Desktop',
  mobile: 'Mobile',
  bot: 'Automated client',
  other: 'Other device',
  unknown: 'Unknown device',
};

/** How each sign-in method reads. */
const METHOD_LABELS: Record<string, string> = {
  pwd: 'Password',
  otp: 'Authenticator code',
  mfa: 'Two-factor',
  passkey: 'Passkey',
  hwk: 'Passkey',
  oauth: 'Connected account',
  fed: 'Connected account',
  sso: 'Single sign-on',
  email: 'Email link',
};

/** The device a session runs on, as a person reads it. */
export const deviceLabel = (device: string): string =>
  DEVICE_LABELS[device] ?? 'Unknown device';

/** How a session signed in, as a person reads it, or an empty string. */
export const methodLabel = (amr: string[]): string =>
  [...new Set(amr.map((method) => METHOD_LABELS[method] ?? method))].join(', ');
