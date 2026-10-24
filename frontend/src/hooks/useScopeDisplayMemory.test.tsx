/**
 * The preset display memory as a page uses it: a change to the display is
 * remembered for that preset, a later visit to the preset restores it, and
 * another preset opens in its own display.
 */

import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { scopeDisplayKey } from '../lib/teamIssueScope';
import { useScopeDisplayMemory } from './useScopeDisplayMemory';

beforeEach(() => {
  localStorage.clear();
});

/** Runs the hook under a router opened at `entry`, handing back the URL parameters. */
const renderMemory = (entry: string, storageKey: string | undefined) =>
  renderHook(
    () => {
      useScopeDisplayMemory(storageKey);
      return useSearchParams();
    },
    {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
      ),
    }
  );

describe('useScopeDisplayMemory', () => {
  const active = scopeDisplayKey('team-1', 'list', 'active');
  const backlog = scopeDisplayKey('team-1', 'list', 'backlog');

  it('remembers a display change and restores it on the next visit', () => {
    const first = renderMemory('/w/mine/team/ENG?scope=active', active);
    act(() => {
      const [params, setParams] = first.result.current;
      const next = new URLSearchParams(params);
      next.set('layout', 'board');
      setParams(next);
    });
    expect(localStorage.getItem(active)).toBe('layout=board');
    first.unmount();

    const again = renderMemory('/w/mine/team/ENG?scope=active', active);
    expect(again.result.current[0].get('layout')).toBe('board');
  });

  it('opens another preset in its own display', () => {
    localStorage.setItem(active, 'layout=board');

    const other = renderMemory('/w/mine/team/ENG?scope=backlog', backlog);

    expect(other.result.current[0].has('layout')).toBe(false);
    expect(localStorage.getItem(active)).toBe('layout=board');
  });

  it('keeps a display the URL sets over the remembered one', () => {
    localStorage.setItem(active, 'layout=board');

    const linked = renderMemory(
      '/w/mine/team/ENG?scope=active&group=priority',
      active
    );

    expect(linked.result.current[0].has('layout')).toBe(false);
    expect(localStorage.getItem(active)).toBe('group=priority');
  });

  it('reads and writes nothing without a key', () => {
    localStorage.setItem(active, 'layout=board');

    const loading = renderMemory('/w/mine/team/ENG?scope=active', undefined);

    expect(loading.result.current[0].has('layout')).toBe(false);
    expect(localStorage.getItem(active)).toBe('layout=board');
  });
});
