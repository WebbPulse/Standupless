/**
 * The toast GitHub's return sends. Covers that every code the callback can send
 * has words, that an unknown code reads as a failure rather than nothing, that
 * the code is stripped from the URL so a reload does not repeat it, and that the
 * section is told so it can re-read the installation.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import GithubReturnToast from './GithubReturnToast';
import { GITHUB_OUTCOMES, githubOutcome } from './githubOutcomes';

/** Prints the current search string so a test can see the code was removed. */
const Search = () => <p data-testid="search">{useLocation().search}</p>;

const renderAt = (path: string, onOutcome = vi.fn()) => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <GithubReturnToast onOutcome={onOutcome} />
      <Search />
    </MemoryRouter>
  );
  return onOutcome;
};

describe('the GitHub return toast', () => {
  it('has words for every code the callback sends', () => {
    for (const code of [
      'installed',
      'updated',
      'pending',
      'invalid_state',
      'stale',
      'taken',
      'already_connected',
      'not_found',
      'not_yours',
      'unbound',
      'error',
    ]) {
      expect(GITHUB_OUTCOMES[code]).toBeDefined();
    }
  });

  it('reads an unknown code as a failure', () => {
    expect(githubOutcome('nonsense').tone).toBe('danger');
  });

  it('shows the outcome, tells the section, and strips the code', async () => {
    const onOutcome = renderAt('/w/acme/settings?github=installed&tab=1');

    expect(await screen.findByText('GitHub connected')).toBeInTheDocument();
    expect(onOutcome).toHaveBeenCalledWith('installed');
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByTestId('search')).toHaveTextContent('?tab=1');
  });

  it('can be dismissed', async () => {
    renderAt('/w/acme/settings?github=pending');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Dismiss' })
    );

    expect(
      screen.queryByText('Waiting on an organization owner')
    ).not.toBeInTheDocument();
  });

  it('shows nothing without a code', () => {
    const onOutcome = renderAt('/w/acme/settings');

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(onOutcome).not.toHaveBeenCalled();
  });
});
