/**
 * The issue page's place in the list it came from: the counter and buttons,
 * j and k stepping to the neighbours, Escape returning to the list, and
 * nothing at all for an issue the trail does not hold.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
  type ShortcutRegistry,
} from '../../hooks/useShortcuts';
import { clearTrail, rememberTrail } from '../../lib/issueTrail';
import IssueTrailNav from './IssueTrailNav';

let registry: ShortcutRegistry;

/** The issue route, showing its key beside the nav as the page bar would. */
const IssueRoute = () => {
  const { key = '' } = useParams<{ key: string }>();
  return (
    <>
      <h1>{key}</h1>
      <IssueTrailNav slug="mine" issueKey={key} />
    </>
  );
};

/** Mounts the nav on an issue address with a list route to return to. */
const renderAt = (key: string) => {
  render(
    <MemoryRouter initialEntries={[`/w/mine/issues/${key}`]}>
      <ShortcutRegistryContext.Provider value={registry}>
        <Routes>
          <Route path="/w/mine/issues/:key" element={<IssueRoute />} />
          <Route path="/w/mine/team/ENG" element={<p>Team list</p>} />
        </Routes>
      </ShortcutRegistryContext.Provider>
    </MemoryRouter>
  );
};

/** Feeds one key press to the registry, as the provider's listener would. */
const press = (key: string): void => {
  act(() => {
    registry.handleKey(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    );
  });
};

beforeEach(() => {
  registry = createShortcutRegistry();
  clearTrail();
  rememberTrail({
    slug: 'mine',
    keys: ['ENG-3', 'ENG-1', 'ENG-2'],
    from: '/w/mine/team/ENG',
  });
});

describe('IssueTrailNav', () => {
  it('shows where the issue sits in the list', () => {
    renderAt('ENG-1');

    expect(screen.getByLabelText('Issue 2 of 3')).toHaveTextContent('2 / 3');
  });

  it('steps to the next issue on J and the previous one on K', () => {
    renderAt('ENG-1');

    press('j');
    expect(screen.getByRole('heading')).toHaveTextContent('ENG-2');
    expect(screen.getByLabelText('Issue 3 of 3')).toBeInTheDocument();

    press('k');
    press('k');
    expect(screen.getByRole('heading')).toHaveTextContent('ENG-3');
  });

  it('stops at the ends rather than wrapping', () => {
    renderAt('ENG-2');

    press('j');

    expect(screen.getByRole('heading')).toHaveTextContent('ENG-2');
    expect(
      screen.getByRole('button', { name: 'Next issue (J)' })
    ).toBeDisabled();
  });

  it('steps from the buttons', () => {
    renderAt('ENG-1');

    fireEvent.click(screen.getByRole('button', { name: 'Previous issue (K)' }));

    expect(screen.getByRole('heading')).toHaveTextContent('ENG-3');
  });

  it('returns to the list on Escape', () => {
    renderAt('ENG-1');

    press('Escape');

    expect(screen.getByText('Team list')).toBeInTheDocument();
  });

  it('renders and binds nothing for an issue outside the trail', () => {
    renderAt('ENG-9');

    expect(screen.queryByLabelText(/Issue \d+ of/)).toBeNull();
    press('Escape');
    expect(screen.getByRole('heading')).toHaveTextContent('ENG-9');
  });
});
