/**
 * The settings layout route: that its pages know they are in settings, and
 * that Escape leaves settings for the last page shown outside them, unless a
 * dialog is open.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useInSettings } from '../../hooks/useSettingsLayout';
import {
  rememberAppRoute,
  resetSettingsReturn,
} from '../../lib/settingsReturn';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
import SettingsLayout from './SettingsLayout';

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => ({
    workspace: { id: 'w1', name: 'Mine', slug: 'mine', role: 'owner' },
    isLoading: false,
    notFound: false,
    error: null,
  }),
}));

/** Shows where the router is and whether the page is in settings. */
const Page = () => {
  const location = useLocation();
  const inSettings = useInSettings();
  return (
    <>
      <output aria-label="where">{location.pathname}</output>
      <output aria-label="in settings">{String(inSettings)}</output>
    </>
  );
};

/** Renders the layout around a settings page, with `extra` beside it. */
const renderLayout = (extra: ReactNode = null) =>
  render(
    <ShortcutProvider>
      <MemoryRouter initialEntries={['/w/mine/settings/profile']}>
        <Routes>
          <Route path="/w/:slug">
            <Route element={<SettingsLayout />}>
              <Route
                path="settings/profile"
                element={
                  <>
                    <Page />
                    {extra}
                  </>
                }
              />
            </Route>
            <Route path="*" element={<Page />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ShortcutProvider>
  );

beforeEach(() => {
  resetSettingsReturn();
});

describe('SettingsLayout', () => {
  it('marks its pages as settings', () => {
    renderLayout();

    expect(screen.getByLabelText('in settings')).toHaveTextContent('true');
  });

  it('leaves settings for the last page outside them on Escape', async () => {
    rememberAppRoute('mine', '/w/mine/team/ENG/issues');
    const user = userEvent.setup();
    renderLayout();

    await user.keyboard('{Escape}');

    expect(screen.getByLabelText('where')).toHaveTextContent(
      '/w/mine/team/ENG/issues'
    );
    expect(screen.getByLabelText('in settings')).toHaveTextContent('false');
  });

  it('goes to the workspace home on Escape when nothing was shown before', async () => {
    const user = userEvent.setup();
    renderLayout();

    await user.keyboard('{Escape}');

    expect(screen.getByLabelText('where')).toHaveTextContent(/^\/w\/mine$/);
  });

  it('leaves Escape to an open dialog', async () => {
    const user = userEvent.setup();
    renderLayout(<div role="dialog" aria-modal="true" aria-label="Open" />);

    await user.keyboard('{Escape}');

    expect(screen.getByLabelText('where')).toHaveTextContent(
      '/w/mine/settings/profile'
    );
  });
});
