/**
 * The `[[` picker's list: recent documents for an empty query, every typed
 * word matched in the title, titles starting with the query ranked first,
 * and the title a created document gets.
 */

import { describe, expect, it } from 'vitest';
import type { DocumentSummaryRead } from '../types/Api';
import {
  DOCUMENT_LINK_LIMIT,
  documentLinkMatches,
  documentLinkTitle,
  UNTITLED_DOCUMENT,
} from './documentLinks';

/** A document summary with the given id and title. */
const doc = (id: string, title: string): DocumentSummaryRead => ({
  document_id: id,
  workspace_id: 'ws-1',
  parent_kind: 'project',
  parent_id: 'p-1',
  parent_name: 'Launch',
  title,
  author_id: 'u-1',
  updated_by: 'u-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  can_edit: true,
  can_delete: true,
});

describe('documentLinkMatches', () => {
  const rows = [
    doc('a', 'Release plan'),
    doc('b', 'Plan for onboarding'),
    doc('c', 'Retro notes'),
  ];

  it('keeps the recent order for an empty query', () => {
    expect(documentLinkMatches(rows, '  ').map((row) => row.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('matches every word and ranks a leading title first', () => {
    expect(documentLinkMatches(rows, 'plan').map((row) => row.id)).toEqual([
      'b',
      'a',
    ]);
    expect(documentLinkMatches(rows, 'plan release')).toEqual([
      {
        kind: 'document',
        id: 'a',
        title: 'Release plan',
        parentName: 'Launch',
      },
    ]);
    expect(documentLinkMatches(rows, 'nothing')).toEqual([]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      doc(String(index), `Doc ${String(index)}`)
    );
    expect(documentLinkMatches(many, 'doc')).toHaveLength(DOCUMENT_LINK_LIMIT);
  });
});

describe('documentLinkTitle', () => {
  it('trims the query and falls back to Untitled', () => {
    expect(documentLinkTitle('  New   spec ')).toBe('New spec');
    expect(documentLinkTitle('')).toBe(UNTITLED_DOCUMENT);
  });
});
