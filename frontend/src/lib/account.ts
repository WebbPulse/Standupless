/**
 * The wording and rules the personal account settings share: the shape a
 * username takes, the sentences for a refused email change, and how a session's
 * device and client read.
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

/** The device a session runs on, as a person reads it. */
export const deviceLabel = (device: string): string =>
  DEVICE_LABELS[device] ?? 'Unknown device';

/** How the products a session's user agent can name read. */
const CLIENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'standupless-cli': 'Standupless CLI',
};

/** The platforms a phone or tablet reports. */
const MOBILE_PLATFORMS = new Set(['iOS', 'Android']);

/** The fields of a session its label reads. */
export interface SessionLabelInput {
  device: string;
  client: string;
  platform: string;
  clientId: string;
  browser?: string;
}

/** The product or browser a session runs in, without its platform, or an empty string. */
const productLabel = (session: SessionLabelInput, appName: string): string => {
  if (session.clientId !== '') {
    return appName !== ''
      ? appName
      : (CLIENT_LABELS[session.client] ?? (session.client || 'Connected app'));
  }
  if (session.client === 'Standupless') {
    return MOBILE_PLATFORMS.has(session.platform)
      ? 'Standupless mobile'
      : 'Standupless desktop';
  }
  if (session.client !== '') {
    return CLIENT_LABELS[session.client] ?? session.client;
  }
  return session.browser ?? '';
};

/**
 * What a session is, as a person reads it: the connected app, client or
 * browser it runs in, with the platform when known, such as `Chrome on macOS`.
 * `appName` is the connected app's name for an OAuth session. A session that
 * names nothing falls back to its device class.
 */
export const sessionLabel = (
  session: SessionLabelInput,
  appName = ''
): string => {
  const product = productLabel(session, appName);
  const platform = session.platform;
  if (product !== '') {
    return platform !== '' ? `${product} on ${platform}` : product;
  }
  if (platform !== '') {
    return `Browser on ${platform}`;
  }
  return deviceLabel(session.device);
};
