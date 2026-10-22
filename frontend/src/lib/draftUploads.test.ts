/**
 * Placeholder references for files held before their issue exists: an image
 * written as an embed and any other file as a link, names cleaned of Markdown
 * syntax, and each placeholder resolved to its stored path or taken out.
 */

import { describe, expect, it } from 'vitest';
import {
  namesPending,
  pendingReference,
  resolvePending,
  stripPending,
} from './draftUploads';

const image = new File(['x'], 'shot.png', { type: 'image/png' });
const pdf = new File(['x'], 'spec [v2].pdf', { type: 'application/pdf' });

describe('pendingReference', () => {
  it('embeds an image and links any other file', () => {
    expect(pendingReference('file-1', image)).toBe(
      '![shot.png](pending-upload:file-1)'
    );
    expect(pendingReference('file-2', pdf)).toBe(
      '[spec v2.pdf](pending-upload:file-2)'
    );
  });
});

describe('resolvePending', () => {
  const body =
    'Intro\n![shot.png](pending-upload:file-1)\n\n[spec.pdf](pending-upload:file-2)\nEnd';

  it('replaces landed files and takes out the rest', () => {
    expect(
      resolvePending(body, (id) => (id === 'file-1' ? '/content/a' : null))
    ).toBe('Intro\n![shot.png](/content/a)\n\nEnd');
  });

  it('strips every placeholder for the first save', () => {
    expect(stripPending(body)).toBe('Intro\n\nEnd');
  });

  it('tells whether a body still names a file', () => {
    expect(namesPending(body, 'file-2')).toBe(true);
    expect(namesPending(body, 'file-3')).toBe(false);
  });
});
