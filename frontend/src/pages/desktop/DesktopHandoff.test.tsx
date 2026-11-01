/**
 * The handoff page names the account before any code is minted, offers a switch,
 * and says the tab can be closed once the app has its sign-in. A desktop browser
 * can also copy the link, for when it would not open the app.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_HANDOFF_STORAGE_KEY,
  pendingAppHandoffPath,
} from '../../lib/pendingAppHandoff';
import { DESKTOP_HANDOFF_PATH } from '../../lib/paths';
import DesktopHandoff from './DesktopHandoff';

const CALLBACK = 'standupless://auth/handoff?code=abc';
const PATH = `${DESKTOP_HANDOFF_PATH}?challenge=abc&scheme=standupless`;

/** What each test can change about the signed in visitor and their browser. */
interface AuthFixture {
  value: {
    isAuthenticated: boolean;
    isLoading: boolean;
    user: { email: string } | null;
    logout: ReturnType<typeof vi.fn>;
  };
  handOffToDesktop: ReturnType<typeof vi.fn>;
  copy: ReturnType<typeof vi.fn>;
  platform: string | null;
}

const auth = vi.hoisted((): AuthFixture => ({
  value: {
    isAuthenticated: true,
    isLoading: false,
    user: { email: 'person@example.com' },
    logout: vi.fn(),
  },
  handOffToDesktop: vi.fn(),
  copy: vi.fn(),
  platform: 'linux',
}));

vi.mock('../../hooks/useAuth', () => ({ useAuth: () => auth.value }));

vi.mock('../../hooks/useCopy', () => ({
  useCopy: () => ({ copied: false, copy: auth.copy }),
}));

vi.mock('@webbpulse/auth/react', () => ({
  useAuthClient: () => ({ handOffToDesktop: auth.handOffToDesktop }),
}));

vi.mock('@webbpulse/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@webbpulse/auth')>()),
  readDesktopHandoffRequest: (path: string) =>
    path.includes('challenge=') ? { challenge: 'abc' } : null,
}));

vi.mock('../../config/app', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/app')>()),
  desktopHandoffSchemes: ['standupless'],
}));

vi.mock('../../lib/desktop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/desktop')>()),
  currentDesktopPlatform: () => auth.platform,
}));

vi.mock('../authentication/AuthLayout', () => ({
  default: ({
    title,
    subtitle,
    children,
  }: {
    title: string;
    subtitle?: string;
    children: React.ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {children}
    </main>
  ),
}));

/** Shows where a redirect landed, query included. */
const Where = () => {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
};

/** Mounts the page at `path` with places to land on. */
const renderPage = (path = PATH) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={DESKTOP_HANDOFF_PATH} element={<DesktopHandoff />} />
        <Route path="/login" element={<Where />} />
        <Route path="/workspaces" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );

const assign = vi.fn();

beforeEach(() => {
  auth.value.isAuthenticated = true;
  auth.value.isLoading = false;
  auth.value.user = { email: 'person@example.com' };
  auth.value.logout.mockReset();
  auth.value.logout.mockResolvedValue(undefined);
  auth.handOffToDesktop.mockReset();
  auth.handOffToDesktop.mockResolvedValue({ ok: true, callbackUrl: CALLBACK });
  auth.copy.mockReset();
  auth.platform = 'linux';
  assign.mockReset();
  vi.stubGlobal('location', { ...window.location, assign });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem(APP_HANDOFF_STORAGE_KEY);
});

describe('DesktopHandoff', () => {
  it('names the account and mints nothing on load', () => {
    renderPage();
    expect(screen.getByTestId('desktop-handoff-confirm')).toHaveTextContent(
      'Continue as person@example.com'
    );
    expect(auth.handOffToDesktop).not.toHaveBeenCalled();
  });

  it('sends a signed out visitor to sign in with the request kept', () => {
    auth.value.isAuthenticated = false;
    auth.value.user = null;
    renderPage();
    expect(screen.getByTestId('where')).toHaveTextContent(
      `/login?returnTo=${encodeURIComponent(PATH)}`
    );
  });

  it('remembers the request for a mailed link to come back through', async () => {
    auth.value.isAuthenticated = false;
    renderPage();
    await waitFor(() => {
      expect(pendingAppHandoffPath()).toBe(PATH);
    });
  });

  it('signs out and returns here to switch account', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('desktop-handoff-switch'));
    expect(auth.value.logout).toHaveBeenCalledWith(
      `/login?returnTo=${encodeURIComponent(PATH)}`
    );
  });

  it('opens the app and says the tab can be closed', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('desktop-handoff-confirm'));
    expect(
      await screen.findByText('You can close this tab')
    ).toBeInTheDocument();
    expect(auth.handOffToDesktop).toHaveBeenCalledWith({ url: PATH });
    expect(assign).toHaveBeenCalledWith(CALLBACK);
    expect(pendingAppHandoffPath()).toBeNull();
  });

  it('reopens the same link rather than minting another', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('desktop-handoff-confirm'));
    fireEvent.click(await screen.findByTestId('desktop-handoff-open-again'));
    expect(assign).toHaveBeenCalledTimes(2);
    expect(auth.handOffToDesktop).toHaveBeenCalledTimes(1);
  });

  it('offers to copy the link on a desktop browser', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('desktop-handoff-confirm'));
    fireEvent.click(await screen.findByTestId('desktop-handoff-copy'));
    expect(auth.copy).toHaveBeenCalledWith(CALLBACK);
  });

  it('offers no copy on a phone', async () => {
    auth.platform = null;
    renderPage();
    fireEvent.click(screen.getByTestId('desktop-handoff-confirm'));
    await screen.findByTestId('desktop-handoff-open-again');
    expect(screen.queryByTestId('desktop-handoff-copy')).toBeNull();
  });

  it('shows a refusal and stays ready', async () => {
    auth.handOffToDesktop.mockResolvedValue({
      ok: false,
      reason: 'rate-limited',
      message: 'Too many attempts.',
    });
    renderPage();
    fireEvent.click(screen.getByTestId('desktop-handoff-confirm'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts.'
    );
    expect(screen.getByTestId('desktop-handoff-confirm')).toBeEnabled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('forgets the way back when the visitor stays in the browser', async () => {
    renderPage();
    await waitFor(() => {
      expect(pendingAppHandoffPath()).toBe(PATH);
    });
    fireEvent.click(screen.getByTestId('desktop-handoff-stay'));
    expect(pendingAppHandoffPath()).toBeNull();
  });
});
