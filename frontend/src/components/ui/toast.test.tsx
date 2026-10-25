/**
 * The notice stack: a button action dismisses its notice and then runs, a
 * link action still opens its route, and Cmd or Ctrl, Alt and X dismisses
 * every notice.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
} from '../../hooks/useShortcuts';
import { clearToasts, currentToasts, showToast } from '../../lib/toast';
import { Toaster } from './toast';

afterEach(() => {
  clearToasts();
});

/** Draws the stack inside a router, as the app does. */
const draw = () =>
  render(
    <MemoryRouter>
      <Toaster />
    </MemoryRouter>
  );

describe('Toaster', () => {
  it('runs a button action once and dismisses its notice', () => {
    const run = vi.fn();
    draw();
    act(() => {
      showToast('Changed status of ENG-1', 'info', {
        action: { label: 'Undo', run },
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(run).toHaveBeenCalledTimes(1);
    expect(currentToasts()).toHaveLength(0);
    expect(screen.queryByText('Changed status of ENG-1')).toBeNull();
  });

  it('draws a link action as a link to its route', () => {
    draw();
    act(() => {
      showToast('Created ENG-2', 'info', {
        action: { label: 'Open', to: '/ws/issue/ENG-2' },
      });
    });

    expect(
      screen.getByRole('link', { name: 'Open' }).getAttribute('href')
    ).toBe('/ws/issue/ENG-2');
  });

  it('dismisses every notice on Cmd or Ctrl, Alt and X', () => {
    const registry = createShortcutRegistry();
    render(
      <ShortcutRegistryContext.Provider value={registry}>
        <MemoryRouter>
          <Toaster />
        </MemoryRouter>
      </ShortcutRegistryContext.Provider>
    );
    act(() => {
      showToast('Copied ENG-1');
      showToast('Changed status of ENG-2');
    });

    const composing = new KeyboardEvent('keydown', {
      key: 'x',
      code: 'KeyX',
      ctrlKey: true,
      altKey: true,
      isComposing: true,
    });
    act(() => {
      registry.handleKey(composing);
    });
    expect(currentToasts()).toHaveLength(2);

    act(() => {
      registry.handleKey(
        new KeyboardEvent('keydown', {
          key: '≈',
          code: 'KeyX',
          metaKey: true,
          altKey: true,
        })
      );
    });

    expect(currentToasts()).toHaveLength(0);
    expect(screen.queryByText('Copied ENG-1')).toBeNull();
  });
});
