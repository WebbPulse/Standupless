/**
 * The toast shown when Slack sends an admin back to team settings after an
 * install. The outcome arrives as `?slack=<code>`, and `ReturnToast` reads it
 * once, shows it in plain words and strips it from the URL.
 */

import React from 'react';
import ReturnToast from '../workspace/ReturnToast';
import { slackOutcome } from './slackOutcomes';

/** Reads `?slack=` once, shows it as a toast, and removes it from the URL. */
export const SlackReturnToast: React.FC = () => (
  <ReturnToast param="slack" describe={slackOutcome} />
);

export default SlackReturnToast;
