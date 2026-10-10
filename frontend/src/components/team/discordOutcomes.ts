/**
 * The words for each outcome the Discord install callback sends back as
 * `?discord=<code>`, kept apart from the toast so the component file exports
 * only components.
 */

import type { ReturnOutcome } from '../workspace/returnOutcome';

/** What an unknown code reads as. */
const FALLBACK: ReturnOutcome = {
  tone: 'danger',
  title: 'Could not add Discord',
  message:
    'Something went wrong while saving the installation. Try again in a moment.',
};

/** Every outcome code the callback can send back, in words. */
export const DISCORD_OUTCOMES: Record<string, ReturnOutcome | undefined> = {
  installed: {
    tone: 'success',
    title: 'Discord connected',
    message:
      'Pick a Discord channel when you add one here, and use /standupless in your server.',
  },
  denied: {
    tone: 'info',
    title: 'Discord was not added',
    message: 'The install was cancelled in Discord. Nothing changed.',
  },
  invalid_state: {
    tone: 'danger',
    title: 'The install link expired',
    message:
      'Each link works once and for a short time. Press Add to Discord to start again.',
  },
  discord_guild_taken: {
    tone: 'danger',
    title: 'Already connected elsewhere',
    message:
      'That Discord server is connected to another Standupless workspace. Remove it there first.',
  },
  not_configured: {
    tone: 'danger',
    title: 'Discord is not available',
    message: 'This environment has no Discord App set up.',
  },
  error: FALLBACK,
};

/** The words for a code, falling back to the generic failure for one this does not know. */
export const discordOutcome = (code: string): ReturnOutcome =>
  DISCORD_OUTCOMES[code] ?? FALLBACK;
