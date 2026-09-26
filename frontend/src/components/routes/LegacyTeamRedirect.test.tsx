/**
 * The redirects from the old `/w/:slug/p/:keyPrefix` addresses: that each old
 * surface lands on the route that replaced it, and that the old milestones
 * address becomes the workspace projects list filtered to that team.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import LegacyTeamRedirect, { type LegacySurface } from './LegacyTeamRedirect';

/** Reports the address the redirect settled on, so a test can assert on it. */
const Landing: React.FC = () => {
  const location = useLocation();
  return (
    <div data-testid="landing">{`${location.pathname}${location.search}`}</div>
  );
};

/** Follows one old address and hands back the address it settled on. */
const follow = (path: string, to?: LegacySurface): string => {
  const { unmount } = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/w/:slug/p/:keyPrefix/*"
          element={
            to === undefined ? (
              <LegacyTeamRedirect />
            ) : (
              <LegacyTeamRedirect to={to} />
            )
          }
        />
        <Route path="*" element={<Landing />} />
      </Routes>
    </MemoryRouter>
  );
  const landed = screen.getByTestId('landing').textContent ?? '';
  unmount();
  return landed;
};

describe('LegacyTeamRedirect', () => {
  it('sends the old team address to the team page', () => {
    expect(follow('/w/mine/p/ENG')).toBe('/w/mine/team/ENG');
  });

  it('sends the old board address to the team board', () => {
    expect(follow('/w/mine/p/ENG/board', 'board')).toBe(
      '/w/mine/team/ENG/board'
    );
  });

  it('sends the old cycles address to the team cycles', () => {
    expect(follow('/w/mine/p/ENG/cycles', 'cycles')).toBe(
      '/w/mine/team/ENG/cycles'
    );
  });

  it('sends the old milestones address to the projects list for that team', () => {
    expect(follow('/w/mine/p/ENG/milestones', 'projects')).toBe(
      '/w/mine/projects?team=ENG'
    );
  });

  it('escapes a key prefix that is not URL safe', () => {
    expect(follow('/w/mine/p/A%26B/milestones', 'projects')).toBe(
      '/w/mine/projects?team=A%26B'
    );
  });
});
