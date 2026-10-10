/**
 * The shape every install return outcome takes, shared by the GitHub, Slack and
 * Discord toasts so one component draws them all.
 */

/** How a return outcome reads: its tone and the sentence shown. */
export interface ReturnOutcome {
  tone: 'success' | 'info' | 'danger';
  title: string;
  message: string;
}
