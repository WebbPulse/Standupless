/**
 * Placeholder references for files held before their issue exists: a stand in
 * content path per file, each placeholder resolved to its stored path or taken
 * out, and the check for whether a body still names a file.
 */

import { ApiError } from '@webbpulse/api-client';
import { describe, expect, it, vi } from 'vitest';
import { attachmentIdOf, isContentPath, isVideoSrc } from './media';
import {
  hasPending,
  namesPending,
  pendingAttachmentId,
  pendingPath,
  pendingReference,
  resolvePending,
  retryHeldRequest,
  stripPending,
  withHeldReferences,
} from './draftUploads';

const shot = pendingPath('ws-1', 'file-1', 'image');
const spec = pendingPath('ws-1', 'file-2', null);
const clip = pendingPath('ws-1', 'file-3', 'video');

describe('pendingPath', () => {
  it('reads as a content path naming the stand in attachment', () => {
    expect(isContentPath(shot)).toBe(true);
    expect(attachmentIdOf(shot)).toBe(pendingAttachmentId('file-1'));
    expect(isVideoSrc(clip)).toBe(true);
    expect(isVideoSrc(shot)).toBe(false);
  });
});

describe('resolvePending', () => {
  const body = `Intro\n![shot.png](${shot})\n\n[spec \\[v2\\].pdf](${spec})\n\n![clip.mp4](${clip})\nEnd`;

  it('replaces landed files and takes out the rest', () => {
    expect(
      resolvePending(body, (id) => (id === 'file-1' ? '/content/a' : null))
    ).toBe('Intro\n![shot.png](/content/a)\n\nEnd');
  });

  it('strips every placeholder for the first save', () => {
    expect(stripPending(body)).toBe('Intro\n\nEnd');
  });

  it('tells whether a body still names a file', () => {
    expect(hasPending(body)).toBe(true);
    expect(hasPending('Plain')).toBe(false);
    expect(namesPending(body, 'file-2')).toBe(true);
    expect(namesPending(body, 'file-4')).toBe(false);
  });
});

describe('pendingReference', () => {
  it('embeds an image and links any other file, names cleaned', () => {
    const image = new File(['x'], 'shot.png', { type: 'image/png' });
    const pdf = new File(['x'], 'spec [v2].pdf', { type: 'application/pdf' });
    expect(pendingReference('ws-1', 'file-1', image)).toBe(
      `![shot.png](${shot})`
    );
    expect(pendingReference('ws-1', 'file-2', pdf)).toBe(
      `[spec v2.pdf](${spec})`
    );
  });
});

describe('withHeldReferences', () => {
  const held = {
    id: 'file-1',
    file: new File(['png'], 'shot.png', { type: 'image/png' }),
  };

  it('adds a reference for a held file the body no longer names', () => {
    expect(withHeldReferences('Look', 'ws-1', [held])).toBe(
      `Look\n\n![shot.png](${shot})`
    );
    expect(withHeldReferences('', 'ws-1', [held])).toBe(`![shot.png](${shot})`);
  });

  it('leaves a body that already names the file alone', () => {
    const body = `![shot.png](${shot})\n\nLook`;
    expect(withHeldReferences(body, 'ws-1', [held])).toBe(body);
  });
});

describe('retryHeldRequest', () => {
  it('tries again after a dropped connection', async () => {
    const request = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValue('landed');

    await expect(retryHeldRequest(request, [0])).resolves.toBe('landed');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('gives up after the last try', async () => {
    const failure = new TypeError('Load failed');
    const request = vi.fn<() => Promise<string>>().mockRejectedValue(failure);

    await expect(retryHeldRequest(request, [0, 0])).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('does not repeat a request the server refused', async () => {
    const refusal = new ApiError({
      status: 413,
      statusText: 'Too Large',
      body: null,
      url: '/attachments',
      method: 'POST',
    });
    const request = vi.fn<() => Promise<string>>().mockRejectedValue(refusal);

    await expect(retryHeldRequest(request, [0])).rejects.toBe(refusal);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
