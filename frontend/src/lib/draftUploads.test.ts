/**
 * Placeholder references for files held before their issue exists: a stand in
 * content path per file, each placeholder resolved to its stored path or taken
 * out, and the check for whether a body still names a file.
 */

import { describe, expect, it } from 'vitest';
import { attachmentIdOf, isContentPath, isVideoSrc } from './media';
import {
  hasPending,
  namesPending,
  pendingAttachmentId,
  pendingPath,
  pendingReference,
  resolvePending,
  stripPending,
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
