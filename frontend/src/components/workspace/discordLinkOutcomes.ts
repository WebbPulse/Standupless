/**
 * The words for each outcome the Discord link callback sends back to
 * notification settings as `?discord_dm=<code>`, kept apart from the page so
 * the component files export only components.
 */

import type { ReturnOutcome } from './returnOutcome';

/** What an unknown code reads as. */
const FALLBACK: ReturnOutcome = {
  tone: 'danger',
  title: 'Could not link Discord',
  message: 'Discord could not be reached. Try again in a minute.',
};

/** Every outcome code the link callback can send back, in words. */
const LINK_OUTCOMES: Record<string, ReturnOutcome | undefined> = {
  linked: {
    tone: 'success',
    title: 'Discord linked',
    message:
      'Notifications you tick under Chat now arrive as direct messages from the Standupless App.',
  },
  denied: {
    tone: 'info',
    title: 'Discord was not linked',
    message: 'Linking was cancelled in Discord. Nothing changed.',
  },
  invalid_state: {
    tone: 'danger',
    title: 'The link expired',
    message:
      'Each link works once and for a short time. Press Link Discord to start again.',
  },
  not_installed: {
    tone: 'danger',
    title: 'Discord is no longer connected',
    message:
      'The Standupless App left the Discord server this workspace used. Ask an admin to connect it again.',
  },
  wrong_account: {
    tone: 'danger',
    title: 'That account cannot be linked',
    message: 'Discord answered with a bot account. Link your own account.',
  },
  unverified_email: {
    tone: 'danger',
    title: 'Confirm your email first',
    message:
      'Your Standupless email address is not confirmed yet. Confirm it, then link Discord again.',
  },
  no_member: {
    tone: 'danger',
    title: 'Not a member here',
    message: 'You are no longer a member of this workspace.',
  },
  error: FALLBACK,
};

/** The words for a code, falling back to the generic failure for one this does not know. */
export const discordLinkOutcome = (code: string): ReturnOutcome =>
  LINK_OUTCOMES[code] ?? FALLBACK;
