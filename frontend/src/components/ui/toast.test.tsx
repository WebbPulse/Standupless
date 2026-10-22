/**
 * The notice stack: a button action dismisses its notice and then runs, and a
 * link action still opens its route.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
