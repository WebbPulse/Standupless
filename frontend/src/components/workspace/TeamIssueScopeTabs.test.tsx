/**
 * The team issue preset switch: one link per preset, the showing one marked
 * as the current page, and each link keeping the filters on screen while it
 * swaps the preset and drops the display options.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import TeamIssueScopeTabs from './TeamIssueScopeTabs';
import type { TeamIssueScope } from '../../lib/teamIssueScope';

/** Renders the switch at `entry` with `current` showing. */
const renderTabs = (entry: string, current: TeamIssueScope): void => {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <TeamIssueScopeTabs current={current} />
    </MemoryRouter>
  );
};

describe('TeamIssueScopeTabs', () => {
  it('offers All issues, Active and Backlog, marking the showing one', () => {
    renderTabs('/w/mine/team/ENG?scope=active', 'active');

    expect(screen.getByRole('link', { name: 'Active' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(
      screen.getByRole('link', { name: 'All issues' })
    ).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Backlog' })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG?scope=backlog'
    );
    expect(screen.getByRole('link', { name: 'All issues' })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG'
    );
  });

  it('keeps the filters and drops the display when it swaps the preset', () => {
    renderTabs(
      '/w/mine/team/ENG/board?f=priority%3Ais%3Ahigh&group=assignee',
      'all'
    );

    const href =
      screen.getByRole('link', { name: 'Active' }).getAttribute('href') ?? '';
    const query = new URLSearchParams(href.split('?')[1]);

    expect(href.startsWith('/w/mine/team/ENG/board?')).toBe(true);
    expect(query.get('f')).toBe('priority:is:high');
    expect(query.get('scope')).toBe('active');
    expect(query.has('group')).toBe(false);
  });
});
