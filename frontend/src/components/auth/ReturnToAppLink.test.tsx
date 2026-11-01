/**
 * The way back to the app shows on the browser's auth pages while a request is
 * kept, and nowhere it would make no sense.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_HANDOFF_PATH } from '../../lib/paths';
import {
  APP_HANDOFF_STORAGE_KEY,
  rememberAppHandoff,
} from '../../lib/pendingAppHandoff';
import ReturnToAppLink from './ReturnToAppLink';

const PATH = `${DESKTOP_HANDOFF_PATH}?challenge=abc&scheme=standupless`;

/** Mounts the link as if on `path`. */
const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ReturnToAppLink />
    </MemoryRouter>
  );

afterEach(() => {
  localStorage.removeItem(APP_HANDOFF_STORAGE_KEY);
  delete (window as { standuplessDesktop?: unknown }).standuplessDesktop;
  vi.restoreAllMocks();
});

describe('ReturnToAppLink', () => {
  it('shows nothing without a kept request', () => {
    renderAt('/reset-password');
    expect(screen.queryByTestId('return-to-app')).toBeNull();
  });

  it('leads back to the handoff page', () => {
    rememberAppHandoff(PATH);
    renderAt('/reset-password');
    expect(screen.getByTestId('return-to-app')).toHaveAttribute('href', PATH);
  });

  it('hides on the handoff page itself', () => {
    rememberAppHandoff(PATH);
    renderAt(PATH);
    expect(screen.queryByTestId('return-to-app')).toBeNull();
  });

  it('hides inside an app', () => {
    rememberAppHandoff(PATH);
    (window as { standuplessDesktop?: unknown }).standuplessDesktop = {
      setBadgeCount: vi.fn(),
    };
    renderAt('/reset-password');
    expect(screen.queryByTestId('return-to-app')).toBeNull();
  });
});
