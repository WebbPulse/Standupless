/**
 * The "via MCP" suffix a change made through a client carries. The web app is
 * the default and stays unlabelled, as do GitHub and jobs, whose rows already
 * name their actor; a row from before sources were recorded has none.
 */

import type { ChangeSource } from '../types/Api';

const LABELS: Partial<Record<ChangeSource, string>> = {
  mcp: 'MCP',
  cli: 'CLI',
  api: 'API',
  email: 'email',
  slack: 'Slack',
};

/** "via MCP", "via CLI", "via API", "via email" or "via Slack", or null when nothing should show. */
export const viaLabel = (
  source: ChangeSource | null | undefined
): string | null => {
  const label = source ? LABELS[source] : undefined;
  return label === undefined ? null : `via ${label}`;
};
