/**
 * The move to team dialog while offline: every team is offered disabled,
 * the dialog carries the connection hint, and a pick moves nothing.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IssueRead, TeamRead } from '../../types/Api';
import MoveIssueDialog from './MoveIssueDialog';

const network = vi.hoisted(() => ({ offline: false }));

vi.mock('../../hooks/useOffline', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOffline: () => network.offline,
  useWritable: (permitted: boolean) => permitted && !network.offline,
}));

const moveIssues = vi.fn();

vi.mock('../../lib/bulkIssueActions', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  moveIssues: (...args: unknown[]) => moveIssues(...args),
}));

afterEach(() => {
  network.offline = false;
  moveIssues.mockReset();
});

/** A team the caller writes issues in. */
const team = (id: string, name: string, keyPrefix: string): TeamRead => ({
  id,
  workspace_id: 'ws-1',
  name,
  key_prefix: keyPrefix,
  description: null,
  estimate_scale: 'off',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  role: 'member',
});

/** The issue being moved, in the first team. */
const issue = { id: 'iss-1', key: 'ENG-1', team_id: 'team-1' } as IssueRead;

describe('MoveIssueDialog offline', () => {
  it('offers every team disabled with the connection hint', async () => {
    network.offline = true;
    const user = userEvent.setup();
    render(
      <MoveIssueDialog
        open
        workspaceId="ws-1"
        workspaceRole="member"
        issues={[issue]}
        teams={[team('team-1', 'Engine', 'ENG'), team('team-2', 'Web', 'WEB')]}
        onClose={vi.fn()}
        onMoved={vi.fn()}
      />
    );

    expect(screen.getByText('Changes need a connection')).toBeInTheDocument();
    const web = screen.getByRole('option', { name: /Web/ });
    expect(web).toHaveAttribute('aria-disabled', 'true');
    await user.click(web);
    expect(moveIssues).not.toHaveBeenCalled();
  });
});
