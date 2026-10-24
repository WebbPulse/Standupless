/**
 * Tests for BuildFreshness: a tab running a build a deploy has replaced loads
 * the new build at its next navigation instead of rendering the next page
 * with code whose chunks are gone, and a current tab never reloads.
 */

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import BuildFreshness from './BuildFreshness';

const renderApp = (props: {
  running: string | null;
  check: (running: string) => Promise<boolean>;
  reload: () => void;
}) =>
  render(
    <MemoryRouter initialEntries={['/w/mine/projects']}>
      <BuildFreshness {...props} />
      <Routes>
        <Route
          path="/w/mine/projects"
          element={<Link to="/w/mine/projects/prj-1">Launch</Link>}
        />
        <Route path="/w/mine/projects/prj-1" element={<p>project page</p>} />
      </Routes>
    </MemoryRouter>
  );

const focusTab = async (): Promise<void> => {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
  });
};

describe('BuildFreshness', () => {
  it('reloads into the new build when the tab next navigates', async () => {
    const user = userEvent.setup();
    const check = vi.fn<(running: string) => Promise<boolean>>(() =>
      Promise.resolve(true)
    );
    const reload = vi.fn();
    renderApp({ running: '/assets/index-old.js', check, reload });

    await focusTab();
    expect(check).toHaveBeenCalledWith('/assets/index-old.js');
    expect(reload).not.toHaveBeenCalled();

    await user.click(screen.getByRole('link', { name: 'Launch' }));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('navigates in place while the build is current', async () => {
    const user = userEvent.setup();
    const check = vi.fn<(running: string) => Promise<boolean>>(() =>
      Promise.resolve(false)
    );
    const reload = vi.fn();
    renderApp({ running: '/assets/index-same.js', check, reload });

    await focusTab();
    await user.click(screen.getByRole('link', { name: 'Launch' }));

    expect(screen.getByText('project page')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does nothing outside a production build', async () => {
    const user = userEvent.setup();
    const check = vi.fn<(running: string) => Promise<boolean>>(() =>
      Promise.resolve(true)
    );
    const reload = vi.fn();
    renderApp({ running: null, check, reload });

    await focusTab();
    await user.click(screen.getByRole('link', { name: 'Launch' }));

    expect(check).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
