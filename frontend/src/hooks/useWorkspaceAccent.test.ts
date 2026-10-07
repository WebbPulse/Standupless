/**
 * The workspace accent hook: it paints and caches the resolved workspace's
 * accent, keeps the pre-painted one while resolving, clears on a missing
 * workspace, and returns to the default when the workspace routes unmount.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCENT_ATTRIBUTE,
  ACCENT_STORAGE_KEY,
  paintAccent,
} from '../lib/accent';
import type { WorkspaceRead } from '../types/Api';
import { useWorkspaceAccent } from './useWorkspaceAccent';

const workspace = (slug: string, accent: string | null): WorkspaceRead => ({
  id: `id-${slug}`,
  name: slug,
  slug,
  plan: 'free',
  created_at: '2026-10-01T00:00:00Z',
  accent_color: accent,
});

const painted = (): string | null =>
  document.documentElement.getAttribute(ACCENT_ATTRIBUTE);

afterEach(() => {
  paintAccent(null);
  localStorage.clear();
});

describe('useWorkspaceAccent', () => {
  it('paints, caches and switches with the workspace, then clears on unmount', () => {
    const { rerender, unmount } = renderHook(
      ({ current }: { current: WorkspaceRead | null }) => {
        useWorkspaceAccent(current, false);
      },
      { initialProps: { current: workspace('acme', '#1f7ae0') } }
    );
    expect(painted()).toBe('#1f7ae0');
    expect(
      (
        JSON.parse(localStorage.getItem(ACCENT_STORAGE_KEY) ?? '{}') as Record<
          string,
          unknown
        >
      )['acme']
    ).toBeDefined();
    rerender({ current: workspace('other', null) });
    expect(painted()).toBeNull();
    unmount();
    expect(painted()).toBeNull();
  });

  it('keeps the pre-painted accent while resolving and clears it when not found', () => {
    paintAccent('#2f9e44');
    const { rerender } = renderHook(
      ({ notFound }: { notFound: boolean }) => {
        useWorkspaceAccent(null, notFound);
      },
      { initialProps: { notFound: false } }
    );
    expect(painted()).toBe('#2f9e44');
    rerender({ notFound: true });
    expect(painted()).toBeNull();
  });
});
