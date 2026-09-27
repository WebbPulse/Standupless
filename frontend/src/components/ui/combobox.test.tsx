/**
 * The searchable list behind every property picker. Covers the keyboard
 * contract a picker relies on: typing filters, the arrows skip disabled rows,
 * Enter picks without submitting an enclosing form, a shortcut picks while
 * the filter is empty, and the multiple and create modes.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Combobox, type ComboboxOption } from './combobox';

const options: ComboboxOption[] = [
  { value: 'a', label: 'Alpha', shortcut: '1', group: 'First' },
  { value: 'b', label: 'Bravo', disabled: true, group: 'First' },
  { value: 'c', label: 'Charlie', keywords: ['third'], group: 'Second' },
];

describe('Combobox', () => {
  it('filters on typing, matching keywords too', async () => {
    const user = userEvent.setup();
    render(
      <Combobox
        label="Pick"
        options={options}
        selected={[]}
        onSelect={vi.fn()}
      />
    );
    await user.type(screen.getByRole('combobox', { name: 'Pick' }), 'third');
    expect(
      screen.getAllByRole('option').map((node) => node.textContent)
    ).toEqual(['Charlie']);
  });

  it('moves past disabled rows and picks with Enter', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onSubmit = vi.fn((event: React.FormEvent) => {
      event.preventDefault();
    });
    render(
      <form onSubmit={onSubmit}>
        <Combobox
          label="Pick"
          options={options}
          selected={[]}
          onSelect={onSelect}
        />
      </form>
    );
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledWith('c');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('starts on the selected row and wraps with the arrows', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <Combobox
        label="Pick"
        options={options}
        selected={['c']}
        onSelect={onSelect}
      />
    );
    const input = screen.getByRole('combobox');
    const active = screen.getByRole('option', { name: /Charlie/ });
    expect(input).toHaveAttribute('aria-activedescendant', active.id);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('picks by shortcut only while the filter is empty', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <Combobox
        label="Pick"
        options={options}
        selected={[]}
        onSelect={onSelect}
      />
    );
    await user.keyboard('1');
    expect(onSelect).toHaveBeenCalledWith('a');
    onSelect.mockClear();
    await user.type(screen.getByRole('combobox'), 'x1');
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText('No results')).toBeInTheDocument();
  });

  it('groups rows under headings and marks the multiple list', () => {
    render(
      <Combobox
        label="Pick"
        multiple
        options={options}
        selected={['a']}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByRole('listbox')).toHaveAttribute(
      'aria-multiselectable',
      'true'
    );
    expect(screen.getByRole('group', { name: 'First' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Alpha/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('offers a create row for unmatched text', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(
      <Combobox
        label="Pick"
        options={options}
        selected={[]}
        onSelect={vi.fn()}
        onCreate={onCreate}
        createLabel={(text) => `Create label "${text}"`}
      />
    );
    await user.type(screen.getByRole('combobox'), 'Delta');
    expect(
      screen.getByRole('option', { name: 'Create label "Delta"' })
    ).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onCreate).toHaveBeenCalledWith('Delta');
  });
});
