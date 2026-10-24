/** Tests for the project page's property shortcuts. */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import BoundKeys from '../../test/BoundKeys';
import { boundKeys, keysBound } from '../../test/shortcuts';
import { DatePicker } from '../issues/PropertyPickers';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
import { HealthPicker } from './ProjectPickers';
import ProjectPropertyKeys, {
  PROJECT_PROPERTY_KEYS,
} from './ProjectPropertyKeys';

/** A properties row with a health and a target date chip, bound to the keys. */
const Row: React.FC<{
  enabled: boolean;
  onHealth: (value: unknown) => void;
}> = ({ enabled, onHealth }) => {
  const row = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={row} role="group" aria-label="Properties">
        <HealthPicker variant="chip" value={null} onChange={onHealth} />
        <DatePicker
          variant="chip"
          field="Target date"
          value={null}
          onChange={() => undefined}
        />
      </div>
      <ProjectPropertyKeys container={row} enabled={enabled} />
    </>
  );
};

const renderRow = (enabled: boolean, onHealth = vi.fn()) =>
  render(
    <ShortcutProvider>
      <BoundKeys />
      <Row enabled={enabled} onHealth={onHealth} />
    </ShortcutProvider>
  );

/** Dispatches one key the way the shortcut layer listens for it. */
const press = (key: string, shiftKey = false) => {
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key, shiftKey, bubbles: true })
    );
  });
};

describe('ProjectPropertyKeys', () => {
  it('binds a key for each project property', async () => {
    renderRow(true);

    await keysBound(...PROJECT_PROPERTY_KEYS.map((shortcut) => shortcut.keys));
  });

  it('opens the health picker on H and saves the choice', async () => {
    const user = userEvent.setup();
    const onHealth = vi.fn();
    renderRow(true, onHealth);
    await keysBound('h');

    press('h');

    expect(
      await screen.findByRole('dialog', { name: 'Health' })
    ).toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: /At risk/ }));
    expect(onHealth).toHaveBeenCalledWith('at_risk');
  });

  it('opens the target date picker on Shift+D', async () => {
    renderRow(true);
    await keysBound('shift+d');

    press('D', true);

    expect(
      await screen.findByRole('dialog', { name: 'Target date' })
    ).toBeInTheDocument();
  });

  it('leaves the pickers shut for a reader who may not edit', async () => {
    renderRow(false);
    await waitFor(() => {
      expect(screen.getByTestId('bound-keys')).toBeInTheDocument();
    });

    press('h');

    expect(boundKeys()).not.toContain('h');
    expect(screen.queryByRole('dialog', { name: 'Health' })).toBeNull();
  });
});
