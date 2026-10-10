/**
 * The toast shown when GitHub sends an admin back to settings after an install.
 *
 * The outcome arrives as `?github=<code>` on the settings URL, and `ReturnToast`
 * reads it once, shows it in plain words and strips it from the URL.
 */

import React from 'react';
import ReturnToast from './ReturnToast';
import { githubOutcome } from './githubOutcomes';

/** Props for GithubReturnToast: what to do once an outcome has been read. */
export interface GithubReturnToastProps {
  /** Called with the outcome code, so the section can re-read the installation. */
  onOutcome?: (code: string) => void;
}

/** Reads `?github=` once, shows it as a toast, and removes it from the URL. */
export const GithubReturnToast: React.FC<GithubReturnToastProps> = ({
  onOutcome,
}) => (
  <ReturnToast
    param="github"
    describe={githubOutcome}
    {...(onOutcome === undefined ? {} : { onOutcome })}
  />
);

export default GithubReturnToast;
