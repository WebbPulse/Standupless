/**
 * How a token's `amr` sign-in methods read, shared by the account Sessions page
 * and the workspace audit log.
 */

/** How each `amr` code reads. */
const METHOD_LABELS: Record<string, string> = {
  pwd: 'Password',
  otp: 'Authenticator code',
  mfa: '2FA',
  swk: 'Passkey',
  hwk: 'Passkey',
  passkey: 'Passkey',
  pin: 'PIN',
  recovery: 'Recovery code',
  oauth: 'Connected account',
  fed: 'Connected account',
  sso: 'Single sign-on',
  email: 'Email link',
};

/** How each social sign-in provider reads. */
const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  github: 'GitHub',
  gitlab: 'GitLab',
  microsoft: 'Microsoft',
  apple: 'Apple',
};

/** Each sign-in method once, in order; `oauth` gives way to the provider after it, and unknown codes stay as sent. */
export const signInMethodLabels = (amr: readonly string[]): string[] => {
  const labels: string[] = [];
  amr.forEach((code, index) => {
    const next = amr[index + 1] ?? '';
    if (code === 'oauth' && PROVIDER_LABELS[next] !== undefined) return;
    const label = METHOD_LABELS[code] ?? PROVIDER_LABELS[code] ?? code;
    if (!labels.includes(label)) labels.push(label);
  });
  return labels;
};

/** How a session signed in, such as "Passkey + PIN", or an empty string. */
export const signInMethodLabel = (amr: readonly string[]): string =>
  signInMethodLabels(amr).join(' + ');
