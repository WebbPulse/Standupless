/**
 * The property pickers every issue surface shares. Covers the keyboard paths
 * a person uses most: number keys for priority and status, statuses grouped
 * by workflow category, assignee with "No assignee" first, labels toggling
 * without closing and created from typed text, and a date that refuses to
 * fall outside its range.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { LabelRead, StatusRead } from '../../types/Api';
import {
  AssigneePicker,
  DatePicker,
  EstimatePicker,
  LabelsPicker,
  PriorityPicker,
  StatusPicker,
} from './PropertyPickers';

const statuses: StatusRead[] = [
  { id: 'st-3', name: 'Doing', category: 'started', position: 2 },
  { id: 'st-1', name: 'Backlog', category: 'backlog', position: 0 },
  { id: 'st-2', name: 'Todo', category: 'unstarted', position: 1 },
  { id: 'st-4', name: 'Done', category: 'completed', position: 3 },
];

const labels: LabelRead[] = [
  { id: 'lb-1', name: 'bug', color: '#ef4444' },
  { id: 'lb-2', name: 'feature', color: '#3b82f6' },
];

describe('PriorityPicker', () => {
  it('opens from the keyboard and picks with a number key', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PriorityPicker value="none" onChange={onChange} />);
    const trigger = screen.getByRole('button', {
      name: 'Priority: No priority',
    });
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveFocus();
    await user.keyboard('1');
    expect(onChange).toHaveBeenCalledWith('urgent');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('does not report a pick of the value already held', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PriorityPicker value="high" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Priority/ }));
    await user.keyboard('{Enter}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the field name on an empty chip', () => {
    render(<PriorityPicker variant="chip" value="none" onChange={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: 'Priority: Priority' })
    ).toBeInTheDocument();
  });
});

describe('StatusPicker', () => {
  it('groups statuses by category in workflow order', async () => {
    const user = userEvent.setup();
    render(
      <StatusPicker statuses={statuses} value="st-2" onChange={vi.fn()} />
    );
    await user.click(screen.getByRole('button', { name: 'Status: Todo' }));
    const groups = screen.getAllByRole('group');
    expect(
      groups.map((group) => group.getAttribute('aria-labelledby') !== null)
    ).toEqual([true, true, true, true]);
    expect(
      screen.getAllByRole('option').map((option) => option.textContent)
    ).toEqual(['Backlog1', 'Todo2', 'Doing3', 'Done4']);
    expect(
      within(screen.getByRole('group', { name: 'Started' })).getByRole('option')
    ).toHaveTextContent('Doing');
  });

  it('filters by typing and picks with Enter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <StatusPicker statuses={statuses} value="st-2" onChange={onChange} />
    );
    await user.click(screen.getByRole('button', { name: 'Status: Todo' }));
    await user.keyboard('do');
    expect(
      screen.getAllByRole('option').map((option) => option.textContent)
    ).toEqual(['Todo2', 'Doing3', 'Done4']);
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('st-4');
  });

  it('closes on Escape without a change', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <StatusPicker statuses={statuses} value="st-2" onChange={onChange} />
    );
    await user.click(screen.getByRole('button', { name: 'Status: Todo' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('cannot open when disabled', () => {
    render(
      <StatusPicker
        disabled
        statuses={statuses}
        value="st-2"
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Status: Todo' })).toBeDisabled();
  });
});

describe('AssigneePicker', () => {
  it('lists No assignee first, then the caller, and clears to null', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AssigneePicker
        currentUserId="u-2"
        people={[
          { user_id: 'u-1', email: 'a@example.com', display_name: 'Ann' },
          { user_id: 'u-2', email: 'b@example.com', display_name: 'Bo' },
        ]}
        value="u-1"
        onChange={onChange}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Assignee: Ann' }));
    const rows = screen
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(rows[0]).toContain('No assignee');
    expect(rows[1]).toContain('Bo');
    await user.keyboard('{Home}{Enter}');
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe('LabelsPicker', () => {
  /** Holds the chosen labels the way a surface would. */
  const Harness = ({
    onCreate,
    onChange,
  }: {
    onCreate?: (name: string) => Promise<LabelRead | null>;
    onChange: (ids: string[]) => void;
  }) => {
    const [value, setValue] = useState<string[]>([]);
    return (
      <LabelsPicker
        labels={labels}
        value={value}
        {...(onCreate === undefined ? {} : { onCreate })}
        onChange={(ids) => {
          setValue(ids);
          onChange(ids);
        }}
      />
    );
  };

  it('toggles several labels without closing', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Labels/ }));
    await user.keyboard('{Enter}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(['lb-1', 'lb-2']);
    expect(screen.getByRole('listbox')).toHaveAttribute(
      'aria-multiselectable',
      'true'
    );
    await user.keyboard('{ArrowUp}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(['lb-2']);
  });

  it('creates a label from typed text and selects it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onCreate = vi.fn((name: string) =>
      Promise.resolve({ id: 'lb-9', name, color: '#10b981' })
    );
    render(<Harness onChange={onChange} onCreate={onCreate} />);
    await user.click(screen.getByRole('button', { name: /Labels/ }));
    await user.keyboard('infra');
    await user.click(
      screen.getByRole('option', { name: 'Create label "infra"' })
    );
    expect(onCreate).toHaveBeenCalledWith('infra');
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(['lb-9']);
    });
  });

  it('offers no create row without a create handler', async () => {
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Labels/ }));
    await user.keyboard('infra');
    expect(
      screen.queryByRole('option', { name: /Create/ })
    ).not.toBeInTheDocument();
  });
});

describe('EstimatePicker', () => {
  it('draws nothing when the scale is off', () => {
    const { container } = render(
      <EstimatePicker scale="off" value={null} onChange={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('DatePicker', () => {
  it('disables presets outside the range and refuses an early custom day', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DatePicker
        field="Due date"
        value={null}
        min="2999-01-01"
        onChange={onChange}
      />
    );
    await user.click(screen.getByRole('button', { name: /Due date/ }));
    expect(screen.getByRole('option', { name: /Today/ })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    const custom = screen.getByLabelText('Custom date');
    await user.type(custom, '2020-01-01{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /due date cannot fall before/i
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears a set date to null', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DatePicker field="Due date" value="2026-10-01" onChange={onChange} />
    );
    await user.click(screen.getByRole('button', { name: /Due date/ }));
    await user.click(screen.getByRole('option', { name: /Clear date/ }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
