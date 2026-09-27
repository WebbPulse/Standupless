/**
 * The inline media helpers. Covers the stored content path and its video
 * marker, which targets count as embeddable, collecting the attachments a body
 * embeds, and resolving a stored path to a signed URL only once its token is
 * held.
 */

import { describe, expect, it } from 'vitest';
import {
  attachmentIdOf,
  contentPath,
  embeddedAttachmentIds,
  isContentPath,
  isEmbeddableSrc,
  isVideoSrc,
  mediaKindOf,
  resolveMediaUrl,
} from './media';

const IMAGE = '/api/workspaces/ws-1/attachments/att-1/content?issue_id=iss-1';
const VIDEO = `${IMAGE.replace('att-1', 'att-2')}&media=video`;

describe('the stored path', () => {
  it('names the workspace, attachment and issue, and marks a video', () => {
    expect(contentPath('ws-1', 'att-1', 'iss-1', 'image')).toBe(IMAGE);
    expect(contentPath('ws-1', 'att-2', 'iss-1', 'video')).toBe(VIDEO);
    expect(contentPath('ws-1', 'att-1', 'iss-1')).toBe(IMAGE);
  });

  it('is recognised, and a lookalike is not', () => {
    expect(isContentPath(IMAGE)).toBe(true);
    expect(isVideoSrc(VIDEO)).toBe(true);
    expect(isVideoSrc(IMAGE)).toBe(false);
    expect(isContentPath(`${IMAGE}&token=x`)).toBe(false);
    expect(isContentPath('/api/workspaces/ws-1/issues/iss-1')).toBe(false);
    expect(attachmentIdOf(VIDEO)).toBe('att-2');
    expect(attachmentIdOf('https://example.com/a.png')).toBeNull();
  });

  it('embeds only a content path or an https URL', () => {
    expect(isEmbeddableSrc(IMAGE)).toBe(true);
    expect(isEmbeddableSrc('https://example.com/a.png')).toBe(true);
    expect(isEmbeddableSrc('http://example.com/a.png')).toBe(false);
    expect(isEmbeddableSrc('data:image/png;base64,AAAA')).toBe(false);
  });
});

describe('the content types', () => {
  it('embeds the allowed images and videos and links anything else', () => {
    expect(mediaKindOf('image/PNG')).toBe('image');
    expect(mediaKindOf('video/quicktime')).toBe('video');
    expect(mediaKindOf('image/svg+xml')).toBeNull();
    expect(mediaKindOf('application/pdf')).toBeNull();
  });
});

describe('the embedded attachments', () => {
  it('lists each attachment a body embeds or links once, in order', () => {
    const body = `![a](${VIDEO})\n\n[b](${IMAGE}) and again ![c](${VIDEO})`;
    expect(embeddedAttachmentIds(body)).toEqual(['att-2', 'att-1']);
    expect(embeddedAttachmentIds(null)).toEqual([]);
  });
});

describe('the resolved URL', () => {
  it('waits for a token, then appends it to the stored path', () => {
    expect(resolveMediaUrl(IMAGE, {})).toBeNull();
    const url = resolveMediaUrl(IMAGE, { 'att-1': 'a.b+c' });
    expect(url?.endsWith(`${IMAGE}&token=a.b%2Bc`)).toBe(true);
  });

  it('passes an https embed through and refuses anything else', () => {
    expect(resolveMediaUrl('https://example.com/a.png', {})).toBe(
      'https://example.com/a.png'
    );
    expect(resolveMediaUrl('javascript:alert(1)', {})).toBeNull();
  });
});
