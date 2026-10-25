/**
 * The saved view's Copy link and Change owner actions: the rule that decides
 * who may hand a view over, and Copy link copying the view's canonical
 * address rather than whatever the page's filters have become.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SavedViewDisplayRead } from '../../api/views';
import { viewPath } from '../../lib/paths';
import { copyViewLink, viewOwnerChange, viewUrl } from './ViewOwnerActions';

const view = (
  override: Partial<SavedViewDisplayRead> = {}
): SavedViewDisplayRead => ({
  view_id: 'view-1',
  workspace_id: 'ws-1',
  name: 'Handover',
  kind: 'list',
  scope: 'workspace',
  team_id: null,
  filter: {},
  sort: 'priority_desc',
  group_by: 'status',
  owner_id: 'owner-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  layout: 'list',
  sub_group_by: null,
  ordering: null,
  visible_properties: null,
  show_sub_issues: true,
  show_completed: true,
  ...override,
});

describe('viewOwnerChange', () => {
  it('lets the owner hand over a shared view', () => {
    expect(viewOwnerChange(view(), 'owner-1', 'member')).toEqual({
      allowed: true,
    });
  });

  it('lets a workspace admin or owner hand over a view they do not own', () => {
    expect(viewOwnerChange(view(), 'someone', 'admin').allowed).toBe(true);
    expect(viewOwnerChange(view(), 'someone', 'owner').allowed).toBe(true);
  });

  it('refuses any other member, with the reason', () => {
    expect(
      viewOwnerChange(view({ scope: 'team' }), 'someone', 'member')
    ).toEqual({
      allowed: false,
      reason: 'Only the owner or a workspace admin can change it',
    });
    expect(viewOwnerChange(view(), undefined, 'guest').allowed).toBe(false);
  });

  it('asks for a personal view to be shared first', () => {
    expect(
      viewOwnerChange(view({ scope: 'personal' }), 'owner-1', 'member')
    ).toEqual({ allowed: false, reason: 'Share the view first' });
  });
});

describe('copyViewLink', () => {
  it('copies the canonical view address', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    copyViewLink('mine', view());

    expect(viewUrl('mine', 'view-1')).toBe(
      `${globalThis.location.origin}${viewPath('mine', 'view-1')}`
    );
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(viewUrl('mine', 'view-1'));
    });
  });
});
