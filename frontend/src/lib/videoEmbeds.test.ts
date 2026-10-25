/**
 * The video link parser: each provider's published link shapes parse to the
 * video id, the player address is rebuilt from that id alone, and anything
 * else, lookalike hosts and odd ids included, stays a plain link. The static
 * renderer reads a bare video link alone in its paragraph as an embed.
 */

import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './markdown';
import { parseVideoEmbed, videoEmbedOfLine } from './videoEmbeds';

const LOOM_ID = '0123456789abcdef0123456789abcdef';

describe('parseVideoEmbed', () => {
  it.each([
    [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'youtube',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ],
    [
      'https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL1&t=1m30s',
      'youtube',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90',
    ],
    [
      'https://youtu.be/dQw4w9WgXcQ?t=42',
      'youtube',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42',
    ],
    [
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'youtube',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ],
    [
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'youtube',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ],
    [
      `https://www.loom.com/share/${LOOM_ID}?sid=abc`,
      'loom',
      `https://www.loom.com/embed/${LOOM_ID}`,
    ],
    [
      'https://vimeo.com/76979871',
      'vimeo',
      'https://player.vimeo.com/video/76979871',
    ],
    [
      'https://vimeo.com/76979871/abcdef1234',
      'vimeo',
      'https://player.vimeo.com/video/76979871?h=abcdef1234',
    ],
    [
      'https://player.vimeo.com/video/76979871?h=abcdef1234&autoplay=1',
      'vimeo',
      'https://player.vimeo.com/video/76979871?h=abcdef1234',
    ],
    [
      'https://share.descript.com/view/AbC123xYz',
      'descript',
      'https://share.descript.com/embed/AbC123xYz',
    ],
  ])('reads %s', (url, provider, embedUrl) => {
    expect(parseVideoEmbed(url)).toMatchObject({ provider, embedUrl, url });
  });

  it.each([
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://evilyoutube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ"onload=x',
    'https://www.youtube.com/channel/UC123',
    'https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ',
    'javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.loom.com/share/not-a-loom-id',
    'https://vimeo.com/channels/staff/76979871',
    'https://vimeo.com/76979871/<script>',
    'https://share.descript.com/view/../../x',
    'https://descript.com/view/AbC123xYz',
    'see https://youtu.be/dQw4w9WgXcQ',
    '',
  ])('leaves %s a link', (url) => {
    expect(parseVideoEmbed(url)).toBeNull();
  });

  it('keeps a start time to whole seconds', () => {
    expect(
      parseVideoEmbed('https://youtu.be/dQw4w9WgXcQ?t=abc')?.embedUrl
    ).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  });
});

describe('videoEmbedOfLine', () => {
  it('reads a bare link with surrounding spaces', () => {
    expect(videoEmbedOfLine('  https://youtu.be/dQw4w9WgXcQ  ')?.id).toBe(
      'dQw4w9WgXcQ'
    );
  });

  it('leaves a bracketed link alone', () => {
    const url = 'https://youtu.be/dQw4w9WgXcQ';
    expect(videoEmbedOfLine(`[${url}](${url})`)).toBeNull();
  });
});

describe('video embeds in the static renderer', () => {
  const url = 'https://youtu.be/dQw4w9WgXcQ';

  it('reads a bare video link alone in its paragraph as an embed', () => {
    const blocks = parseMarkdown(`intro\n\n${url}\n\noutro`);
    expect(blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'embed',
      'paragraph',
    ]);
  });

  it('reads one inside a quote', () => {
    const [quote] = parseMarkdown(`> ${url}`);
    expect(quote?.type).toBe('quote');
    if (quote?.type !== 'quote') return;
    expect(quote.children[0]?.type).toBe('embed');
  });

  it('leaves a video link in running text, a list or brackets a link', () => {
    for (const source of [
      `see ${url}`,
      `line one\n${url}`,
      `${url}\nline two`,
      `- ${url}`,
      `[${url}](${url})`,
    ]) {
      expect(
        parseMarkdown(source).some((block) => block.type === 'embed')
      ).toBe(false);
    }
  });
});
