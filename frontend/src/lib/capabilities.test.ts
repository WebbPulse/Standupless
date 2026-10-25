/**
 * The permission settings decide what a member is offered: inviting only when
 * the workspace opens invites to members, creating teams unless it closes them
 * to admins, and a guest neither.
 */

import { describe, expect, it } from 'vitest';
import { canCreateTeam, canInviteMembers } from './capabilities';

describe('canCreateTeam', () => {
  it('lets every member create teams by default and never a guest', () => {
    expect(canCreateTeam('member')).toBe(true);
    expect(canCreateTeam('admin')).toBe(true);
    expect(canCreateTeam('guest')).toBe(false);
    expect(canCreateTeam('guest', 'members')).toBe(false);
  });

  it('keeps team creation to admins when the workspace says so', () => {
    expect(canCreateTeam('member', 'admins')).toBe(false);
    expect(canCreateTeam('admin', 'admins')).toBe(true);
    expect(canCreateTeam('owner', 'admins')).toBe(true);
  });
});

describe('canInviteMembers', () => {
  it('keeps invites to admins by default', () => {
    expect(canInviteMembers({ role: 'member' })).toBe(false);
    expect(canInviteMembers({ role: 'admin' })).toBe(true);
    expect(
      canInviteMembers({ role: 'owner', invite_permission: 'admins' })
    ).toBe(true);
  });

  it('lets a member invite when the workspace allows it, never a guest', () => {
    expect(
      canInviteMembers({ role: 'member', invite_permission: 'members' })
    ).toBe(true);
    expect(
      canInviteMembers({ role: 'guest', invite_permission: 'members' })
    ).toBe(false);
  });
});
