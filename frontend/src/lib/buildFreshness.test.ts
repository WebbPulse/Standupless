/**
 * Tests for reading which build a tab runs and which one is live, and that a
 * failed read never reports a newer build.
 */

import { describe, expect, it } from 'vitest';
import {
  buildIdFromHtml,
  isNewerBuildLive,
  runningBuildId,
} from './buildFreshness';

const shell = (entry: string): string =>
  `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script></head><body><div id="root"></div></body></html>`;

describe('buildIdFromHtml', () => {
  it('reads the hashed entry script', () => {
    expect(buildIdFromHtml(shell('/assets/index-BPt4CNVO.js'))).toBe(
      '/assets/index-BPt4CNVO.js'
    );
  });

  it('reads nothing from a page with no hashed entry', () => {
    expect(buildIdFromHtml(shell('/src/main.tsx'))).toBeNull();
  });
});

describe('runningBuildId', () => {
  it('reads the entry this document booted from', () => {
    const doc = new DOMParser().parseFromString(
      shell('/assets/index-abc123.js'),
      'text/html'
    );
    expect(runningBuildId(doc)).toBe('/assets/index-abc123.js');
  });

  it('is null outside a production build', () => {
    const doc = new DOMParser().parseFromString(
      shell('/src/main.tsx'),
      'text/html'
    );
    expect(runningBuildId(doc)).toBeNull();
  });
});

describe('isNewerBuildLive', () => {
  it('reports a newer build when the served shell names another entry', async () => {
    await expect(
      isNewerBuildLive('/assets/index-old.js', () =>
        Promise.resolve(shell('/assets/index-new.js'))
      )
    ).resolves.toBe(true);
  });

  it('reports none when the served shell names the same entry', async () => {
    await expect(
      isNewerBuildLive('/assets/index-same.js', () =>
        Promise.resolve(shell('/assets/index-same.js'))
      )
    ).resolves.toBe(false);
  });

  it('reports none when the shell cannot be read', async () => {
    await expect(
      isNewerBuildLive('/assets/index-old.js', () =>
        Promise.reject(new Error('offline'))
      )
    ).resolves.toBe(false);
  });

  it('reports none when the shell names no entry', async () => {
    await expect(
      isNewerBuildLive('/assets/index-old.js', () =>
        Promise.resolve('<html></html>')
      )
    ).resolves.toBe(false);
  });
});
