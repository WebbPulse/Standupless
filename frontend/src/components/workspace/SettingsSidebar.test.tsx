/**
 * The settings sidebar: the groups an admin and a member see, the team
 * entries that open onto their settings sections, the highlighted current
 * page, and the Back to app link to the last page shown outside settings.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamsContext } from '../../contexts/TeamsContextDefinition';
import {
  rememberAppRoute,
  resetSettingsReturn,
} from '../../lib/settingsReturn';
import type { TeamRead, WorkspaceRead, WorkspaceRole } from '../../types/Api';
import SettingsSidebar from './SettingsSidebar';

/** Two teams the viewer belongs to and one they do not. */
const TEAMS = [
  { id: 't1', name: 'Engine', key_prefix: 'ENG', is_member: true },
  { id: 't2', name: 'Design', key_prefix: 'DES', is_member: true },
  { id: 't3', name: 'Sales', key_prefix: 'SAL', is_member: false },
] as unknown as TeamRead[];

/** Renders the sidebar for workspace "mine" at `path`, as `role`. */
const renderSidebar = (
  role: WorkspaceRole = 'owner',
  path = '/w/mine/settings/profile',
  onNavigate = vi.fn()
) => {
  const workspace = {
    id: 'w1',
    name: 'Mine',
    slug: 'mine',
    role,
  } as unknown as WorkspaceRead;
  render(
    <MemoryRouter initialEntries={[path]}>
      <TeamsContext.Provider
        value={{
          data: TEAMS,
          isLoading: false,
          error: null,
          refetch: () => Promise.resolve(),
        }}
      >
        <SettingsSidebar workspace={workspace} onNavigate={onNavigate} />
      </TeamsContext.Provider>
    </MemoryRouter>
  );
  return onNavigate;
};

/** The headings over the sidebar's groups, in order. */
const headings = (): string[] =>
  within(screen.getByRole('navigation', { name: 'Settings' }))
    .getAllByRole('heading')
    .map((heading) => heading.textContent ?? '');

beforeEach(() => {
  resetSettingsReturn();
});

describe('SettingsSidebar', () => {
  it('shows an admin every group and their teams', () => {
    renderSidebar('admin');

    expect(headings()).toEqual([
      'Account',
      'Workspace',
      'Administration',
      'Features',
      'Integrations',
      'Your teams',
    ]);
    expect(screen.getByRole('link', { name: 'Audit log' })).toHaveAttribute(
      'href',
      '/w/mine/settings/audit-log'
    );
  });

  it('hides Administration and Features from a member', () => {
    renderSidebar('member');

    expect(headings()).toEqual([
      'Account',
      'Workspace',
      'Integrations',
      'Your teams',
    ]);
    expect(
      screen.queryByRole('link', { name: 'Audit log' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Workspace' })).toHaveAttribute(
      'href',
      '/w/mine/settings'
    );
  });

  it('highlights the current page', () => {
    renderSidebar('owner', '/w/mine/settings/labels');

    expect(screen.getByRole('link', { name: 'Labels' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(screen.getByRole('link', { name: 'Workspace' })).not.toHaveAttribute(
      'aria-current'
    );
  });

  it('lists only the teams the viewer belongs to and opens one onto its sections', async () => {
    const user = userEvent.setup();
    renderSidebar();

    expect(screen.getByRole('button', { name: 'Engine' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(
      screen.queryByRole('button', { name: 'Sales' })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Engine' }));

    const sections = screen.getByRole('list', { name: 'Engine settings' });
    expect(
      within(sections).getByRole('link', { name: 'General' })
    ).toHaveAttribute(
      'href',
      '/w/mine/team/ENG/settings#team-settings-general'
    );
    expect(
      within(sections).getByRole('link', { name: 'Webhooks' })
    ).toHaveAttribute(
      'href',
      '/w/mine/team/ENG/settings#team-settings-webhooks'
    );
  });

  it('opens the team in view and marks its current section', () => {
    renderSidebar('member', '/w/mine/team/ENG/settings#team-settings-cycles');

    expect(screen.getByRole('button', { name: 'Engine' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Design' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    const sections = screen.getByRole('list', { name: 'Engine settings' });
    expect(
      within(sections).getByRole('link', { name: 'Cycles' })
    ).toHaveAttribute('aria-current', 'page');
  });

  it('goes back to the last page shown outside settings', async () => {
    rememberAppRoute('mine', '/w/mine/team/ENG/issues');
    const user = userEvent.setup();
    const onNavigate = renderSidebar();

    const back = screen.getByRole('link', { name: 'Back to app' });
    expect(back).toHaveAttribute('href', '/w/mine/team/ENG/issues');
    await user.click(back);
    expect(onNavigate).toHaveBeenCalled();
  });

  it('puts the settings search at the top', () => {
    renderSidebar();

    expect(
      screen.getByRole('combobox', { name: 'Search settings' })
    ).toBeInTheDocument();
  });
});
