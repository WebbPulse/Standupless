/**
 * The settings search: that typing lists the ranked matches with their
 * section path, that Enter and a click open the match's route and anchor, that
 * a member is not offered admin only pages, and that landing on an anchor
 * highlights its section for a moment.
 */

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HIGHLIGHT_ATTRIBUTE,
  HIGHLIGHT_MS,
} from '../../hooks/useSettingsHighlight';
import type { WorkspaceRole } from '../../types/Api';
import SettingsSearch from './SettingsSearch';

/** Shows the current path and hash, so a test can read where a match went. */
const Where = () => {
  const location = useLocation();
  return (
    <output aria-label="where">{`${location.pathname}${location.hash}`}</output>
  );
};

/** Renders the search for workspace "mine" with team Engine, at `path`. */
const renderSearch = (
  role: WorkspaceRole = 'owner',
  path = '/w/mine/settings/billing',
  extra: ReactNode = null
) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <SettingsSearch
                workspace={{ slug: 'mine', role }}
                teams={[{ name: 'Engine', key_prefix: 'ENG' }]}
              />
              <Where />
              {extra}
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );

afterEach(() => {
  vi.useRealTimers();
});

describe('SettingsSearch', () => {
  it('lists nothing until a term is typed', async () => {
    const user = userEvent.setup();
    renderSearch();

    await user.click(screen.getByRole('combobox', { name: 'Search settings' }));

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('lists a team control under its section path and opens it with Enter', async () => {
    const user = userEvent.setup();
    renderSearch();

    await user.type(
      screen.getByRole('combobox', { name: 'Search settings' }),
      'cooldown'
    );
    const [first] = screen.getAllByRole('option');
    expect(first).toHaveTextContent('Cooldown');
    expect(first).toHaveTextContent('Engine > Cycles');
    expect(first).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');

    expect(screen.getByLabelText('where')).toHaveTextContent(
      '/w/mine/team/ENG/settings#team-settings-cycles'
    );
    expect(
      screen.getByRole('combobox', { name: 'Search settings' })
    ).toHaveValue('');
  });

  it('moves the highlight with the arrow keys and opens a match on click', async () => {
    const user = userEvent.setup();
    renderSearch();

    await user.type(
      screen.getByRole('combobox', { name: 'Search settings' }),
      'api key'
    );
    await user.keyboard('{ArrowDown}');
    const options = screen.getAllByRole('option');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    await user.click(options[1] as HTMLElement);

    expect(screen.getByLabelText('where')).toHaveTextContent(
      '/w/mine/settings/api-keys'
    );
  });

  it('offers a member no admin only page', async () => {
    const user = userEvent.setup();
    renderSearch('member');

    await user.type(
      screen.getByRole('combobox', { name: 'Search settings' }),
      'audit log'
    );

    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByText('No settings match')).toBeInTheDocument();
  });

  it('clears the term on Escape', async () => {
    const user = userEvent.setup();
    renderSearch();
    const input = screen.getByRole('combobox', { name: 'Search settings' });

    await user.type(input, 'theme');
    await user.keyboard('{Escape}');

    expect(input).toHaveValue('');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('highlights the section the hash names, then lets it go', () => {
    vi.useFakeTimers();
    renderSearch(
      'owner',
      '/w/mine/settings/security#settings-sso',
      <div data-testid="sso" id="settings-sso" />
    );
    const section = screen.getByTestId('sso');

    expect(section).toHaveAttribute(HIGHLIGHT_ATTRIBUTE);
    act(() => {
      vi.advanceTimersByTime(HIGHLIGHT_MS);
    });
    expect(section).not.toHaveAttribute(HIGHLIGHT_ATTRIBUTE);
  });
});
