/**
 * The words for each outcome the GitHub install callback sends back as
 * `?github=<code>`, kept apart from the toast so the component file exports only
 * components.
 */

/** How a return outcome reads: its tone and the sentence shown. */
export interface GithubOutcome {
  tone: 'success' | 'info' | 'danger';
  title: string;
  message: string;
}

/** What an unknown code reads as. */
const FALLBACK: GithubOutcome = {
  tone: 'danger',
  title: 'Could not connect GitHub',
  message:
    'Something went wrong while saving the installation. Try again in a moment.',
};

/** Every outcome code the callback can send back, in words. */
export const GITHUB_OUTCOMES: Record<string, GithubOutcome | undefined> = {
  installed: {
    tone: 'success',
    title: 'GitHub connected',
    message:
      'Pull requests and branches that name an issue key now link to it.',
  },
  updated: {
    tone: 'success',
    title: 'GitHub updated',
    message: 'The repository list now matches what you chose on GitHub.',
  },
  pending: {
    tone: 'info',
    title: 'Waiting on an organization owner',
    message:
      'GitHub sent your request to the organization owners. Connect again once one of them approves it.',
  },
  invalid_state: {
    tone: 'danger',
    title: 'The connect link expired',
    message:
      'Each link works once and for ten minutes. Press Connect GitHub to start again.',
  },
  stale: {
    tone: 'danger',
    title: 'That installation was not changed',
    message:
      'The App was already installed on that account. Choose repositories and save on GitHub, or uninstall it there and connect again.',
  },
  taken: {
    tone: 'danger',
    title: 'Already connected elsewhere',
    message:
      'That GitHub account is connected to another Standupless workspace. Disconnect it there first.',
  },
  already_connected: {
    tone: 'danger',
    title: 'This workspace already has GitHub',
    message:
      'Disconnect the current account before connecting a different one.',
  },
  not_found: {
    tone: 'danger',
    title: 'Installation not found',
    message:
      'GitHub did not recognise that installation. Try connecting again.',
  },
  not_yours: {
    tone: 'danger',
    title: 'Installation not on your account',
    message:
      'Your GitHub account cannot reach that installation. Ask an owner of the GitHub account to connect it.',
  },
  unbound: {
    tone: 'info',
    title: 'Not connected to a workspace',
    message:
      'Open a workspace’s settings and press Connect GitHub to link this installation.',
  },
  error: {
    tone: 'danger',
    title: 'Could not connect GitHub',
    message:
      'Something went wrong while saving the installation. Try again in a moment.',
  },
};

/** The words for a code, falling back to the generic failure for one this does not know. */
export const githubOutcome = (code: string): GithubOutcome =>
  GITHUB_OUTCOMES[code] ?? FALLBACK;
