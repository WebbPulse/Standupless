/**
 * Where a dialog puts focus when it opens: on the first control in its body,
 * never on the Close button, so opening one from the keyboard does not pop the
 * Close tooltip; and on a control the content focused itself, when it did.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import Dialog from './dialog';

/** A button that opens a dialog holding a text field and a Save button. */
const Opener: React.FC<{ autoFocusSave?: boolean }> = ({
  autoFocusSave = false,
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open
      </button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title="Rename"
      >
        <input aria-label="Name" />
        <button type="button" autoFocus={autoFocusSave}>
          Save
        </button>
      </Dialog>
    </>
  );
};

describe('Dialog focus on open', () => {
  it('focuses the first control in the body, not Close', () => {
    render(<Opener />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.keyDown(opener, { key: 'Enter' });
    fireEvent.click(opener);

    expect(screen.getByLabelText('Name')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Close' })).not.toHaveFocus();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keeps focus on a control the content focused itself', () => {
    render(<Opener autoFocusSave />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
  });

  it('falls back to the panel when the body has no control', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Notice">
        <p>Nothing to press here.</p>
      </Dialog>
    );

    expect(screen.getByRole('dialog', { name: 'Notice' })).toHaveFocus();
  });

  it('puts Close at the end of the header when the title is hidden', () => {
    render(
      <Dialog open onClose={vi.fn()} title="Pick" hideTitle>
        <input aria-label="Filter" />
      </Dialog>
    );

    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.closest('.ml-auto')).not.toBeNull();
  });
});
