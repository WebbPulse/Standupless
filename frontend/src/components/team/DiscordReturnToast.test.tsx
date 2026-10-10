/**
 * The toast Discord's return sends. Covers that every code the callback can
 * send has words, that an unknown code reads as a failure rather than nothing,
 * and that the code is stripped from the URL so a reload does not repeat it.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import DiscordReturnToast from './DiscordReturnToast';
import { DISCORD_OUTCOMES, discordOutcome } from './discordOutcomes';

/** Prints the current search string so a test can see the code was removed. */
const Search = () => <p data-testid="search">{useLocation().search}</p>;

const renderAt = (path: string) => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <DiscordReturnToast />
      <Search />
    </MemoryRouter>
  );
};

describe('the Discord return toast', () => {
  it('has words for every code the callback sends', () => {
    for (const code of [
      'installed',
      'denied',
      'error',
      'invalid_state',
      'discord_guild_taken',
      'not_configured',
    ]) {
      expect(DISCORD_OUTCOMES[code]).toBeDefined();
    }
  });

  it('reads an unknown code as a failure', () => {
    expect(discordOutcome('nonsense').tone).toBe('danger');
  });

  it('shows a success and strips the code', async () => {
    renderAt('/w/acme/team/ENG/settings?discord=installed&tab=1');

    expect(await screen.findByText('Discord connected')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByTestId('search')).toHaveTextContent('?tab=1');
  });

  it('shows a refusal as an alert', async () => {
    renderAt('/w/acme/team/ENG/settings?discord=discord_guild_taken');

    expect(
      await screen.findByText('Already connected elsewhere')
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByTestId('search')).toBeEmptyDOMElement();
  });
});
