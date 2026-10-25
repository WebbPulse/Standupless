/**
 * The workspace frame keeps its page body positioned, so a visually hidden
 * label or input deep in a long page scrolls inside the body rather than
 * stretching the shell or the document below the viewport. The frame itself
 * and the sidebar column are positioned and clip, so the app shell above them
 * never becomes a second scroller beside the list's own. On a desktop the
 * sidebar collapses to a hover zone and an expand button, and its edge resizes
 * it within bounds from the keyboard and resets on a double click. Under the
 * settings layout the settings sidebar takes the app sidebar's place, and on a
 * phone the page bar's back button opens it as a full screen list.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  readSidebarCollapsed,
  readSidebarWidth,
  resetSidebarLayout,
  setSidebarCollapsed,
  setSidebarWidth,
} from '../../hooks/useSidebarLayout';
import { SettingsLayoutContext } from '../../hooks/useSettingsLayout';
import WorkspaceShell from './WorkspaceShell';

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => ({
    workspace: { id: 'w1', name: 'Acme', slug: 'acme', role: 'owner' },
    isLoading: false,
    notFound: false,
    error: null,
  }),
}));

vi.mock('../../hooks/useDesktopNotifications', () => ({
  useDesktopNotifications: () => undefined,
}));

vi.mock('./Sidebar', () => ({
  default: ({ onCollapse }: { onCollapse?: () => void }) => (
    <nav data-testid="sidebar">
      {onCollapse !== undefined && (
        <button type="button" onClick={onCollapse}>
          Collapse sidebar
        </button>
      )}
    </nav>
  ),
}));

vi.mock('./SettingsSidebar', () => ({
  default: ({
    fullScreen,
    onNavigate,
  }: {
    fullScreen?: boolean;
    onNavigate?: () => void;
  }) => (
    <nav
      data-testid={fullScreen === true ? 'settings-list' : 'settings-sidebar'}
    >
      <button type="button" onClick={onNavigate}>
        Labels
      </button>
    </nav>
  ),
}));

vi.mock('./PeekPane', () => ({
  PeekPane: () => null,
}));

/** Mounts the shell around a page body with the given flush setting. */
const renderShell = (flush: boolean) =>
  render(
    <MemoryRouter>
      <WorkspaceShell title="Settings" flush={flush}>
        <p>page body</p>
      </WorkspaceShell>
    </MemoryRouter>
  );

/** Mounts the shell as a settings page, under the settings layout. */
const renderSettingsShell = () =>
  render(
    <MemoryRouter initialEntries={['/w/acme/settings/labels']}>
      <SettingsLayoutContext.Provider value={true}>
        <WorkspaceShell title="Settings">
          <p>page body</p>
        </WorkspaceShell>
      </SettingsLayoutContext.Provider>
    </MemoryRouter>
  );

beforeEach(() => {
  resetSidebarLayout();
});

describe('WorkspaceShell', () => {
  it('positions the scrolling body so hidden content scrolls with it', () => {
    renderShell(false);
    const body = screen.getByText('page body').parentElement;
    expect(body).toHaveClass('relative', 'min-h-0', 'overflow-y-auto');
  });

  it('positions a flush body too', () => {
    renderShell(true);
    const body = screen.getByText('page body').parentElement;
    expect(body).toHaveClass('relative', 'min-h-0', 'overflow-hidden');
  });

  it('contains and clips everything inside the frame so the app shell never scrolls', () => {
    renderShell(true);
    expect(screen.getByTestId('signed-in')).toHaveClass(
      'relative',
      'flex',
      'min-h-0',
      'flex-1',
      'overflow-clip'
    );
    expect(screen.getByTestId('sidebar-frame')).toHaveClass(
      'relative',
      'min-h-0',
      'overflow-hidden'
    );
    expect(screen.getByTestId('content-panel')).toHaveClass(
      'min-w-0',
      'flex-1',
      'overflow-hidden'
    );
  });
});

describe('the desktop sidebar', () => {
  it('collapses from its button and gives the panel the full width', () => {
    renderShell(false);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    expect(readSidebarCollapsed()).toBe(true);
    expect(screen.queryByTestId('sidebar-frame')).toBeNull();
    expect(screen.getByTestId('content-panel')).toHaveClass('lg:ml-2');
  });

  it('shows the sidebar as an overlay from the left edge while collapsed', () => {
    setSidebarCollapsed(true);
    renderShell(false);

    expect(screen.queryByTestId('sidebar-peek')).toBeNull();
    fireEvent.mouseEnter(screen.getByTestId('sidebar-hover-zone'));
    expect(screen.getByTestId('sidebar-peek')).toBeInTheDocument();
    fireEvent.mouseLeave(screen.getByTestId('sidebar-peek'));
    expect(screen.queryByTestId('sidebar-peek')).toBeNull();
  });

  it('expands again from the page bar button', () => {
    setSidebarCollapsed(true);
    renderShell(false);

    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));

    expect(readSidebarCollapsed()).toBe(false);
    expect(screen.getByTestId('sidebar-frame')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand sidebar' })).toBeNull();
  });

  it('draws the sidebar at the remembered width', () => {
    setSidebarWidth(300);
    renderShell(false);

    expect(screen.getByTestId('sidebar-frame')).toHaveStyle({ width: '300px' });
    expect(screen.getByRole('separator')).toHaveAttribute(
      'aria-valuenow',
      '300'
    );
  });

  it('resizes from the keyboard within the bounds', () => {
    renderShell(false);
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' });

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH + 8);

    fireEvent.keyDown(handle, { key: 'End' });
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    expect(readSidebarWidth()).toBe(SIDEBAR_MAX_WIDTH);

    fireEvent.keyDown(handle, { key: 'Home' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(readSidebarWidth()).toBe(SIDEBAR_MIN_WIDTH);
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDEBAR_MIN_WIDTH));
  });

  it('resets the width on a double click', () => {
    setSidebarWidth(340);
    renderShell(false);

    fireEvent.doubleClick(screen.getByRole('separator'));

    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('a settings page', () => {
  it('shows the settings sidebar in place of the app sidebar', () => {
    renderSettingsShell();

    expect(
      within(screen.getByTestId('sidebar-frame')).getByTestId(
        'settings-sidebar'
      )
    ).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Open navigation' })
    ).toBeNull();
  });

  it('opens the full screen settings list on a phone from the back button', () => {
    renderSettingsShell();
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All settings' }));

    const list = screen.getByRole('dialog', { name: 'Settings' });
    expect(list).toHaveAttribute('aria-modal', 'true');
    expect(list).toHaveClass('fixed', 'inset-0');
    expect(within(list).getByTestId('settings-list')).toBeInTheDocument();
  });

  it('closes the list once an entry is followed', () => {
    renderSettingsShell();
    fireEvent.click(screen.getByRole('button', { name: 'All settings' }));

    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Settings' })).getByRole(
        'button',
        { name: 'Labels' }
      )
    );

    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
  });

  it('closes the list from its close button', () => {
    renderSettingsShell();
    fireEvent.click(screen.getByRole('button', { name: 'All settings' }));

    fireEvent.click(
      screen.getByRole('button', { name: 'Close settings list' })
    );

    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
  });
});
