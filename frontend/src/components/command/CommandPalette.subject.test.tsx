/**
 * The chip over the palette's input that names what its issue actions act on:
 * the issue key and title when one issue is in focus, a count for a
 * selection, and nothing when no issue is in focus.
 */

import { render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { subjectOf, usePublishIssueSubject } from '../../hooks/useIssueSubject';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
import CommandPalette from './CommandPalette';

vi.mock('../../api/documents', () => ({
  listWorkspaceDocuments: () => Promise.resolve([]),
}));

vi.mock('../../api/views', () => ({
  search: () => Promise.resolve([]),
}));

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

/** Publishes the given issues as the subject, as a list or issue page does. */
const Publisher: React.FC<{ issues: { key: string; title: string }[] }> = ({
  issues,
}) => {
  usePublishIssueSubject(subjectOf(issues));
  return null;
};

/** Renders the open palette beside a publisher of the given issues. */
const renderPalette = (issues: { key: string; title: string }[]): void => {
  render(
    <MemoryRouter initialEntries={['/w/mine']}>
      <ShortcutProvider>
        <Publisher issues={issues} />
        <CommandPalette
          open
          onClose={vi.fn()}
          workspace={{ id: 'ws-1', slug: 'mine', role: 'owner' }}
          teams={[]}
        />
      </ShortcutProvider>
    </MemoryRouter>
  );
};

describe('the palette subject chip', () => {
  it('names the one issue in focus by key and title', () => {
    renderPalette([{ key: 'GHS-12', title: 'Sync issue titles' }]);

    const chip = screen.getByTestId('palette-subject');
    expect(chip).toHaveTextContent('GHS-12');
    expect(chip).toHaveTextContent('Sync issue titles');
  });

  it('counts a selection of several issues', () => {
    renderPalette([
      { key: 'GHS-12', title: 'Sync issue titles' },
      { key: 'GHS-13', title: 'Sync labels' },
    ]);

    expect(screen.getByTestId('palette-subject')).toHaveTextContent('2 issues');
  });

  it('shows no chip with no issue in focus', () => {
    renderPalette([]);

    expect(screen.queryByTestId('palette-subject')).toBeNull();
  });
});
