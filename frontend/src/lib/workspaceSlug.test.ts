/**
 * Retired workspace slugs: a workspace answers to its current and retired
 * slugs, the list lookup finds the workspace that retired one, and the
 * redirect path swaps only the slug segment, keeping the rest of the path,
 * the query and the hash.
 */

import { describe, expect, it } from 'vitest';
import type { WorkspaceRead } from '../types/Api';
import {
  answersToSlug,
  pathWithSlug,
  workspaceRetiring,
} from './workspaceSlug';

const workspace = (slug: string, retired: string[] = []): WorkspaceRead => ({
  id: `ws-${slug}`,
  name: slug,
  slug,
  plan: 'free',
  created_at: '2026-10-01T00:00:00Z',
  role: 'admin',
  retired_slugs: retired,
});

describe('workspaceSlug', () => {
  it('answers to the current slug and every retired one', () => {
    const acme = workspace('acme-labs', ['acme']);
    expect(answersToSlug(acme, 'acme-labs')).toBe(true);
    expect(answersToSlug(acme, 'acme')).toBe(true);
    expect(answersToSlug(acme, 'other')).toBe(false);
  });

  it('finds the workspace that retired a slug', () => {
    const list = [workspace('other'), workspace('acme-labs', ['acme'])];
    expect(workspaceRetiring(list, 'acme')?.slug).toBe('acme-labs');
    expect(workspaceRetiring(list, 'nobody')).toBeNull();
  });

  it('keeps the path, query and hash when the slug changes', () => {
    expect(
      pathWithSlug(
        '/w/acme/issue/ENG-1',
        '?tab=activity',
        '#comment-2',
        'acme',
        'acme-labs'
      )
    ).toBe('/w/acme-labs/issue/ENG-1?tab=activity#comment-2');
    expect(pathWithSlug('/w/acme', '', '', 'acme', 'acme-labs')).toBe(
      '/w/acme-labs'
    );
  });
});
