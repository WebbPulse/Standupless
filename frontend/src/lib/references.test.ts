/**
 * The `#` reference picker's rules. Covers when typing opens the picker, which
 * queries search can answer, how a search answer becomes the picker's list,
 * what a pick writes, and which links read back as project or document chips.
 */

import { describe, expect, it } from 'vitest';
import type {
  DocumentSummaryRead,
  SearchListRead,
  SearchProjectRead,
  SearchResultRead,
} from '../types/Api';
import {
  isSearchable,
  linkedReference,
  referenceHref,
  referenceItems,
  referenceMarkdown,
  referenceQuery,
  REFERENCE_LIMITS,
} from './references';

const TEAMS = [{ key_prefix: 'ENG', retired_key_prefixes: ['OLD'] }];
const ORIGIN = 'https://app.example.com';

/** An issue hit with the given key. */
const issueHit = (key: string): SearchResultRead => ({
  issue_id: `iss-${key}`,
  key,
  title: `Title ${key}`,
  team_id: 'team-1',
  status_id: 'st-1',
  status_name: 'Todo',
  status_category: 'unstarted',
  status_color: null,
  status_icon: null,
  assignee_id: null,
  updated_at: '2026-10-23T00:00:00Z',
  score: 1,
});

/** A project hit with the given id. */
const projectHit = (id: string): SearchProjectRead => ({
  project_id: id,
  name: `Project ${id}`,
  status: 'planned',
  health: null,
  icon: null,
  color: '#ff0000',
  lead_id: null,
  team_ids: [],
  target_date: null,
  updated_at: '2026-10-23T00:00:00Z',
});

/** A document hit with the given id. */
const documentHit = (id: string): DocumentSummaryRead =>
  ({
    document_id: id,
    title: `Doc ${id}`,
    parent_name: 'Launch',
  }) as DocumentSummaryRead;

describe('referenceQuery', () => {
  it('opens on a # at the start or after whitespace', () => {
    expect(referenceQuery('#', 1)).toEqual({
      start: 0,
      query: '',
      trigger: 'hash',
    });
    expect(referenceQuery('see #road', 9)).toEqual({
      start: 4,
      query: 'road',
      trigger: 'hash',
    });
  });

  it('stays shut for a # inside a word or after a space in the query', () => {
    expect(referenceQuery('page#anchor', 11)).toBeNull();
    expect(referenceQuery('#road map', 9)).toBeNull();
  });

  it('reads only up to the caret', () => {
    expect(referenceQuery('#roadmap', 3)?.query).toBe('ro');
  });

  it('opens on a key of a known team, retired prefixes included', () => {
    expect(referenceQuery('fixes ENG-12', 12, TEAMS)).toEqual({
      start: 6,
      query: 'ENG-12',
      trigger: 'key',
    });
    expect(referenceQuery('OLD-', 4, TEAMS)?.trigger).toBe('key');
  });

  it('ignores a key whose prefix names no team', () => {
    expect(referenceQuery('ABC-12', 6, TEAMS)).toBeNull();
    expect(referenceQuery('ENG-12', 6)).toBeNull();
  });
});

describe('isSearchable', () => {
  it('answers a full key and any word of two characters', () => {
    expect(isSearchable('ENG-12')).toBe(true);
    expect(isSearchable('ui')).toBe(true);
    expect(isSearchable('roa')).toBe(true);
    expect(isSearchable('a roadmap')).toBe(true);
  });

  it('holds back a query search would refuse', () => {
    expect(isSearchable('')).toBe(false);
    expect(isSearchable('a')).toBe(false);
    expect(isSearchable('ENG-')).toBe(false);
    expect(isSearchable('a b')).toBe(false);
  });
});

describe('referenceItems', () => {
  it('lists issues, then projects, then documents', () => {
    const items = referenceItems({
      results: [issueHit('ENG-1')],
      projects: [projectHit('prj-1')],
      documents: [documentHit('doc-1')],
    });

    expect(items.map((item) => item.kind)).toEqual([
      'issue',
      'project',
      'document',
    ]);
    expect(items[0]).toMatchObject({
      key: 'ENG-1',
      statusName: 'Todo',
      statusCategory: 'unstarted',
    });
    expect(items[1]).toMatchObject({ name: 'Project prj-1', color: '#ff0000' });
    expect(items[2]).toMatchObject({
      title: 'Doc doc-1',
      parentName: 'Launch',
    });
  });

  it('caps each kind so one cannot crowd out the others', () => {
    const answer: SearchListRead = {
      results: Array.from({ length: 10 }, (_, i) => issueHit(`ENG-${i}`)),
      projects: Array.from({ length: 10 }, (_, i) => projectHit(`prj-${i}`)),
      documents: Array.from({ length: 10 }, (_, i) => documentHit(`doc-${i}`)),
    };
    const items = referenceItems(answer);
    const count = (kind: string) =>
      items.filter((item) => item.kind === kind).length;

    expect(count('issue')).toBe(REFERENCE_LIMITS.issue);
    expect(count('project')).toBe(REFERENCE_LIMITS.project);
    expect(count('document')).toBe(REFERENCE_LIMITS.document);
  });

  it('reads an answer with no projects or documents', () => {
    expect(referenceItems({ results: [] })).toEqual([]);
  });
});

describe('referenceMarkdown', () => {
  it('writes an issue as its key', () => {
    const [issue] = referenceItems({ results: [issueHit('ENG-7')] });

    expect(issue && referenceMarkdown(issue, ORIGIN, 'acme')).toBe('ENG-7');
  });

  it('writes a project or document as a link to its page', () => {
    const [project, document] = referenceItems({
      results: [],
      projects: [projectHit('prj-1')],
      documents: [documentHit('doc-1')],
    });

    expect(project && referenceMarkdown(project, ORIGIN, 'acme')).toBe(
      '[Project prj-1](https://app.example.com/w/acme/projects/prj-1)'
    );
    expect(document && referenceMarkdown(document, ORIGIN, 'acme')).toBe(
      '[Doc doc-1](https://app.example.com/w/acme/documents/doc-1)'
    );
  });

  it('escapes brackets that would end the link text early', () => {
    expect(
      referenceMarkdown(
        {
          kind: 'project',
          id: 'p',
          name: 'a [b] \\c',
          icon: null,
          color: null,
        },
        ORIGIN,
        'acme'
      )
    ).toBe('[a \\[b\\] \\\\c](https://app.example.com/w/acme/projects/p)');
  });
});

describe('linkedReference', () => {
  it('reads the link a pick writes back to its target', () => {
    const href = referenceHref(ORIGIN, 'acme', {
      kind: 'document',
      id: 'doc-1',
      title: 'Doc',
      parentName: 'Launch',
    });

    expect(linkedReference(href, ORIGIN)).toEqual({
      kind: 'document',
      slug: 'acme',
      id: 'doc-1',
    });
    expect(
      linkedReference(`${ORIGIN}/w/acme/projects/prj-1/?tab=issues`, ORIGIN)
    ).toEqual({ kind: 'project', slug: 'acme', id: 'prj-1' });
  });

  it('leaves links to another origin or another page alone', () => {
    expect(
      linkedReference('https://elsewhere.example.com/w/acme/projects/p', ORIGIN)
    ).toBeNull();
    expect(linkedReference(`${ORIGIN}/w/acme/issues/ENG-1`, ORIGIN)).toBeNull();
    expect(
      linkedReference(`${ORIGIN}/w/acme/projects/p/extra`, ORIGIN)
    ).toBeNull();
  });
});
