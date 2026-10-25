/**
 * The print-only pieces of a printed page. Covers that the endnotes and the
 * properties line carry the print-only class, so the screen never shows them,
 * that an endnote prints its number, author, quote and replies, that a page
 * with no open thread prints no endnotes, and that empty properties drop out.
 */

import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { CommentRead } from '../../types/Api';
import PrintEndnotes from './PrintEndnotes';
import PrintProperties from './PrintProperties';

const comment = (
  id: string,
  at: string,
  overrides: Partial<CommentRead> = {}
): CommentRead => ({
  comment_id: id,
  issue_id: 'd-1',
  workspace_id: 'w-1',
  team_id: 't-1',
  body: `Body of ${id}`,
  parent_comment_id: null,
  author_id: 'u-1',
  author: { user_id: 'u-1', email: 'ada@example.com', display_name: 'Ada' },
  mentions: [],
  reactions: [],
  reply_count: 0,
  created_at: at,
  edited_at: null,
  ...overrides,
});

describe('PrintEndnotes', () => {
  it('renders open threads as print-only numbered endnotes', () => {
    render(
      <MemoryRouter>
        <PrintEndnotes
          comments={[
            comment('c-1', '2026-10-01T12:00:00Z', {
              anchor: { quote: 'the launch plan' },
            }),
            comment('r-1', '2026-10-02T12:00:00Z', {
              parent_comment_id: 'c-1',
              author: {
                user_id: 'u-2',
                email: 'grace@example.com',
                display_name: 'Grace',
              },
            }),
            comment('c-2', '2026-10-03T12:00:00Z', {
              resolution: {
                resolved_by: 'u-1',
                resolved_at: '2026-10-04T00:00:00Z',
              },
            }),
          ]}
        />
      </MemoryRouter>
    );
    const section = screen.getByTestId('print-endnotes');
    expect(section).toHaveClass('print-only');
    expect(section).not.toHaveClass('screen-only');
    const notes = within(section).getAllByRole('listitem');
    expect(notes[0]).toHaveClass('print-endnote');
    expect(section).toHaveTextContent('[1]');
    expect(section).toHaveTextContent('the launch plan');
    expect(section).toHaveTextContent('Body of c-1');
    expect(section).toHaveTextContent('Grace');
    expect(section).toHaveTextContent('Body of r-1');
    expect(section).not.toHaveTextContent('Body of c-2');
    expect(section).not.toHaveTextContent('[2]');
  });

  it('renders nothing when every thread is resolved', () => {
    const { container } = render(
      <PrintEndnotes
        comments={[
          comment('c-1', '2026-10-01T12:00:00Z', {
            resolution: {
              resolved_by: 'u-1',
              resolved_at: '2026-10-04T00:00:00Z',
            },
          }),
        ]}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('PrintProperties', () => {
  it('prints the set properties on one print-only line', () => {
    render(
      <PrintProperties items={['STUP-1', null, 'In Progress', '', 'High']} />
    );
    const line = screen.getByTestId('print-properties');
    expect(line).toHaveClass('print-only');
    expect(line).toHaveTextContent('STUP-1 · In Progress · High');
  });

  it('renders nothing when no property is set', () => {
    const { container } = render(<PrintProperties items={[null, '']} />);
    expect(container).toBeEmptyDOMElement();
  });
});
