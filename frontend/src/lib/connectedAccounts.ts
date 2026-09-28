/**
 * How the connected accounts section names a linked provider account, and the
 * page the provider callback returns to.
 */

import type { OAuthLink } from '@webbpulse/auth';

/** Where the provider callback returns to. */
export const SECURITY_PATH = '/security';

/** How the linked account reads: `@login` for GitHub, else the provider email. */
export const accountLabel = (link: OAuthLink): string => {
  if (link.login !== undefined && link.login !== '') return `@${link.login}`;
  return link.email;
};
