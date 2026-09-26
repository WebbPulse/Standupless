/**
 * The team surface switch: that every tab links to its own route, that the
 * showing one is marked as the current page, and that the links carry the slug
 * and key prefix they were given.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import TeamTabs, { type TeamTab } from './TeamTabs';

/** Renders the switch for one team with 'current' showing. */
const renderTabs = (current: TeamTab): void => {
  render(
    <MemoryRouter>
      <TeamTabs slug="mine" keyPrefix="ENG" current={current} />
    </MemoryRouter>
  );
};

describe('TeamTabs', () => {
  it('links each surface to its own route', () => {
    renderTabs('issues');

    expect(screen.getByRole('link', { name: 'Issues' })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG'
    );
    expect(screen.getByRole('link', { name: 'Board' })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG/board'
    );
    expect(screen.getByRole('link', { name: 'Cycles' })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG/cycles'
    );
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG/settings'
    );
  });

  it('marks only the showing surface as the current page', () => {
    renderTabs('board');

    expect(screen.getByRole('link', { name: 'Board' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(screen.getByRole('link', { name: 'Issues' })).not.toHaveAttribute(
      'aria-current'
    );
  });

  it('carries the slug and key prefix it was given', () => {
    render(
      <MemoryRouter>
        <TeamTabs slug="other" keyPrefix="DES" current="cycles" />
      </MemoryRouter>
    );

    expect(screen.getByRole('link', { name: 'Cycles' })).toHaveAttribute(
      'href',
      '/w/other/team/DES/cycles'
    );
  });
});
