/**
 * The page header's filter row. Covers that the row keeps its chips in one
 * sideways scrolling line below the `sm` breakpoint, dissolves into the
 * toolbar on a desktop so the toolbar wraps as before, and that a page
 * header's toolbar holds it.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PageHeader, { FILTER_ROW_CLASS, FilterRow } from './page-header';

/** Renders a header whose toolbar holds a filter row of three chips. */
const renderHeader = () =>
  render(
    <PageHeader
      title="Projects"
      toolbar={
        <FilterRow>
          <button type="button">Status</button>
          <button type="button">Lead</button>
          <button type="button">Labels</button>
        </FilterRow>
      }
    />
  );

/** The filter row around the chips. */
const filterRow = (): HTMLElement => {
  const row = screen
    .getByRole('button', { name: 'Status' })
    .closest('[data-filter-row]');
  if (!(row instanceof HTMLElement)) throw new Error('no filter row');
  return row;
};

describe('FilterRow', () => {
  it('scrolls sideways in one line below the sm breakpoint', () => {
    renderHeader();

    expect(filterRow()).toHaveClass(
      'max-sm:w-full',
      'max-sm:overflow-x-auto',
      'max-sm:*:shrink-0'
    );
    expect(filterRow()).not.toHaveClass('flex-wrap');
  });

  it('dissolves into the toolbar on a desktop', () => {
    renderHeader();

    expect(filterRow()).toHaveClass('sm:contents');
    for (const name of FILTER_ROW_CLASS.split(' ')) {
      expect(
        name.startsWith('max-sm:') ||
          name.startsWith('sm:') ||
          ['flex', 'items-center', 'gap-1.5'].includes(name)
      ).toBe(true);
    }
  });

  it('keeps every chip in the header toolbar', () => {
    renderHeader();

    expect(screen.getByRole('banner')).toContainElement(filterRow());
    expect(filterRow().children).toHaveLength(3);
  });

  it('takes extra classes', () => {
    render(<FilterRow className="ml-1">chips</FilterRow>);

    expect(screen.getByText('chips')).toHaveClass('ml-1', 'sm:contents');
  });
});
