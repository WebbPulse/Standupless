/**
 * The readable path segment rule for projects and initiatives: the slug a
 * name folds to, the segment built from it, and the id read back out of any
 * segment, stale slugs included. The backend's own tests hold the same cases.
 */

import { describe, expect, it } from 'vitest';
import {
  SLUG_MAX_LENGTH,
  idFromReadable,
  nameSlug,
  readableId,
} from './readableIds';
import { initiativePath, projectPath, projectUpdatesTabPath } from './paths';

const ID = '01M5SCBRDDWDSDX5WJDGTCV6CQ';

describe('nameSlug', () => {
  it('folds a plain name to lowercase kebab-case', () => {
    expect(nameSlug('Launch Plan Q4')).toBe('launch-plan-q4');
  });

  it('folds accents and drops other unicode', () => {
    expect(nameSlug('Café Déjà Vu')).toBe('cafe-deja-vu');
    expect(nameSlug('日本 rollout')).toBe('rollout');
    expect(nameSlug('Straße')).toBe('strae');
  });

  it('drops emoji and collapses punctuation', () => {
    expect(nameSlug('🚀 Ship it!!! (v2.0)')).toBe('ship-it-v2-0');
    expect(nameSlug('--a__b--')).toBe('a-b');
  });

  it('gives an empty slug for a name with nothing left', () => {
    expect(nameSlug('')).toBe('');
    expect(nameSlug('🚀🎉')).toBe('');
    expect(nameSlug('!!!')).toBe('');
  });

  it('caps long names without a trailing hyphen', () => {
    const slug = nameSlug(`${'a'.repeat(59)} bcd`);
    expect(slug).toBe('a'.repeat(59));
    expect(nameSlug('word '.repeat(40)).length).toBeLessThanOrEqual(
      SLUG_MAX_LENGTH
    );
    expect(nameSlug('word '.repeat(40)).endsWith('-')).toBe(false);
  });

  it('is deterministic', () => {
    expect(nameSlug('Same Name')).toBe(nameSlug('Same Name'));
  });
});

describe('readableId', () => {
  it('puts the slug before a ULID', () => {
    expect(readableId(ID, 'Launch Plan')).toBe(`launch-plan-${ID}`);
  });

  it('keeps the bare id when there is no slug or the id is no ULID', () => {
    expect(readableId(ID, '🚀')).toBe(ID);
    expect(readableId(ID, null)).toBe(ID);
    expect(readableId('prj-1', 'Launch')).toBe('prj-1');
  });
});

describe('idFromReadable', () => {
  it('reads the id from a bare ULID, a current slug and a stale one', () => {
    expect(idFromReadable(ID)).toBe(ID);
    expect(idFromReadable(`launch-plan-${ID}`)).toBe(ID);
    expect(idFromReadable(`an-old-name-${ID}`)).toBe(ID);
  });

  it('keeps a segment with no ULID at its end whole', () => {
    expect(idFromReadable('prj-1')).toBe('prj-1');
    expect(idFromReadable(`x${ID}`)).toBe(`x${ID}`);
  });
});

describe('project and initiative paths', () => {
  it('build the readable form when the name is known', () => {
    expect(projectPath('acme', { project_id: ID, name: 'Launch' })).toBe(
      `/w/acme/projects/launch-${ID}`
    );
    expect(projectPath('acme', { project_id: ID, name: 'Launch' }, 'ENG')).toBe(
      `/w/acme/projects/launch-${ID}?team=ENG`
    );
    expect(
      projectUpdatesTabPath('acme', { project_id: ID, name: 'Launch' })
    ).toBe(`/w/acme/projects/launch-${ID}?tab=updates`);
    expect(initiativePath('acme', { initiative_id: ID, name: 'Grow EU' })).toBe(
      `/w/acme/initiatives/grow-eu-${ID}`
    );
  });

  it('build the bare form from an id alone', () => {
    expect(projectPath('acme', ID)).toBe(`/w/acme/projects/${ID}`);
    expect(initiativePath('acme', ID)).toBe(`/w/acme/initiatives/${ID}`);
  });
});
