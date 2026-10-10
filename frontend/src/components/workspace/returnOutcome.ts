/**
 * The shape every install return outcome takes, shared by the GitHub and Slack
 * toasts so one component draws both.
 */

/** How a return outcome reads: its tone and the sentence shown. */
export interface ReturnOutcome {
  tone: 'success' | 'info' | 'danger';
  title: string;
  message: string;
}
