/**
 * The toast shown when Discord sends an admin back to team settings after an
 * install. The outcome arrives as `?discord=<code>`, and `ReturnToast` reads it
 * once, shows it in plain words and strips it from the URL.
 */

import React from 'react';
import ReturnToast from '../workspace/ReturnToast';
import { discordOutcome } from './discordOutcomes';

/** Reads `?discord=` once, shows it as a toast, and removes it from the URL. */
export const DiscordReturnToast: React.FC = () => (
  <ReturnToast param="discord" describe={discordOutcome} />
);

export default DiscordReturnToast;
