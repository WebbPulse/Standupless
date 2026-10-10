/**
 * The words for each outcome the Slack install callback sends back as
 * `?slack=<code>`, kept apart from the toast so the component file exports only
 * components.
 */

import type { ReturnOutcome } from '../workspace/returnOutcome';

/** What an unknown code reads as. */
const FALLBACK: ReturnOutcome = {
  tone: 'danger',
  title: 'Could not add Slack',
  message:
    'Something went wrong while saving the installation. Try again in a moment.',
};

/** Every outcome code the callback can send back, in words. */
export const SLACK_OUTCOMES: Record<string, ReturnOutcome | undefined> = {
  installed: {
    tone: 'success',
    title: 'Slack connected',
    message:
      'Pick a Slack channel when you add one here, and issue links unfurl in Slack.',
  },
  denied: {
    tone: 'info',
    title: 'Slack was not added',
    message: 'The install was cancelled in Slack. Nothing changed.',
  },
  invalid_state: {
    tone: 'danger',
    title: 'The install link expired',
    message:
      'Each link works once and for a short time. Press Add to Slack to start again.',
  },
  enterprise_unsupported: {
    tone: 'danger',
    title: 'Enterprise Grid is not supported',
    message:
      'Install the App into a single Slack workspace rather than across an Enterprise Grid organization.',
  },
  slack_team_taken: {
    tone: 'danger',
    title: 'Already connected elsewhere',
    message:
      'That Slack workspace is connected to another Standupless workspace. Remove it there first.',
  },
  not_configured: {
    tone: 'danger',
    title: 'Slack is not available',
    message: 'This environment has no Slack App set up.',
  },
  error: FALLBACK,
};

/** The words for a code, falling back to the generic failure for one this does not know. */
export const slackOutcome = (code: string): ReturnOutcome =>
  SLACK_OUTCOMES[code] ?? FALLBACK;
