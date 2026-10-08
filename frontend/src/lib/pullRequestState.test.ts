/**
 * The pull request state styles. Covers the GitHub color semantics for each
 * state, a distinct icon per state, theme token classes rather than literal
 * colors, and the fallback for a state the client does not know.
 */

import {
  LuGitMerge,
  LuGitPullRequest,
  LuGitPullRequestClosed,
  LuGitPullRequestDraft,
} from 'react-icons/lu';
import { describe, expect, it } from 'vitest';
import {
  PULL_REQUEST_STATE_STYLES,
  pullRequestStateStyle,
} from './pullRequestState';

describe('pull request state styles', () => {
  it.each([
    ['open', 'Open', LuGitPullRequest, 'text-success'],
    ['draft', 'Draft', LuGitPullRequestDraft, 'text-text-faint'],
    ['merged', 'Merged', LuGitMerge, 'text-merged'],
    ['closed', 'Closed', LuGitPullRequestClosed, 'text-danger'],
  ] as const)('styles %s', (state, label, icon, colorClass) => {
    expect(pullRequestStateStyle(state)).toEqual({ label, icon, colorClass });
  });

  it('never colors merged with the accent or the danger color', () => {
    expect(PULL_REQUEST_STATE_STYLES.merged.colorClass).not.toMatch(
      /accent|danger|warning/
    );
  });

  it('gives each state its own icon and color', () => {
    const styles = Object.values(PULL_REQUEST_STATE_STYLES);
    expect(new Set(styles.map((style) => style.icon)).size).toBe(styles.length);
    expect(new Set(styles.map((style) => style.colorClass)).size).toBe(
      styles.length
    );
  });

  it('uses theme token classes, never literal colors', () => {
    for (const style of Object.values(PULL_REQUEST_STATE_STYLES)) {
      expect(style.colorClass).toMatch(/^text-[a-z-]+$/);
    }
  });

  it('falls back to open for an unknown state', () => {
    expect(pullRequestStateStyle('queued')).toBe(
      PULL_REQUEST_STATE_STYLES.open
    );
  });
});
