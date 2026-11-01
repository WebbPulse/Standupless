/**
 * Tests for the chunk reload guard: which errors count as a pruned chunk, and
 * that a tab reloads for one at most once per window instead of looping.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHUNK_RELOAD_STORAGE_KEY,
  CHUNK_RELOAD_WINDOW_MS,
  installChunkRecovery,
  isChunkLoadError,
  joinChunkReload,
  reloadOnceForChunkError,
} from './chunkReload';

afterEach(() => {
  globalThis.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://standupless.dev/assets/RichMarkdownEditor-abc.js',
    'error loading dynamically imported module',
    'Importing a module script failed.',
    'Unable to preload CSS for /assets/index-abc.css',
    "'text/html' is not a valid JavaScript MIME type.",
    'Loading chunk 42 failed.',
  ])('recognises %s', (message) => {
    expect(isChunkLoadError(new Error(message))).toBe(true);
  });

  it('recognises an error named ChunkLoadError', () => {
    const error = new Error('gone');
    error.name = 'ChunkLoadError';
    expect(isChunkLoadError(error)).toBe(true);
  });

  it('does not treat other errors as chunk errors', () => {
    expect(
      isChunkLoadError(new TypeError('Cannot read properties of undefined'))
    ).toBe(false);
    expect(
      isChunkLoadError('Failed to fetch dynamically imported module')
    ).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe('reloadOnceForChunkError', () => {
  it('reloads the first time and records when', () => {
    const reload = vi.fn();
    expect(reloadOnceForChunkError(reload, 1_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(globalThis.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY)).toBe(
      '1000'
    );
  });

  it('refuses a second reload inside the window', () => {
    const reload = vi.fn();
    reloadOnceForChunkError(reload, 1_000);
    expect(
      reloadOnceForChunkError(reload, 1_000 + CHUNK_RELOAD_WINDOW_MS - 1)
    ).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads again once the window has passed', () => {
    const reload = vi.fn();
    reloadOnceForChunkError(reload, 1_000);
    expect(
      reloadOnceForChunkError(reload, 1_000 + CHUNK_RELOAD_WINDOW_MS)
    ).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not reload when it cannot remember the reload', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage is disabled');
    });
    const reload = vi.fn();
    expect(reloadOnceForChunkError(reload, 1_000)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('a chunk Vite failed to load', () => {
  it('reloads without cancelling the event, so the import still rejects', () => {
    const reload = vi.fn();
    installChunkRecovery(reload);
    const event = new Event('vite:preloadError', { cancelable: true });

    window.dispatchEvent(event);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it('joins a reload already on its way instead of refusing it', () => {
    const reload = vi.fn();
    reloadOnceForChunkError(reload, Date.now());

    expect(joinChunkReload()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
