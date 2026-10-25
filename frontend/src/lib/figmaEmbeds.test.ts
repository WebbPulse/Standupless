/**
 * The Figma link parser: https figma.com file, design, prototype and board
 * links parse to the file key and frame, the embed address is Figma's public
 * one built from the canonical link alone, and anything else stays a link.
 * The static renderer reads a bare Figma link alone in its paragraph as an
 * embed.
 */

import { describe, expect, it } from 'vitest';
import { parseFigmaLink } from './figmaEmbeds';
import { parseMarkdown } from './markdown';
import { parseVideoEmbed, VIDEO_EMBED_ORIGINS } from './videoEmbeds';

const KEY = 'aBcDeFgHiJkLmNoPqRsTuV';

/** Figma's public embed address for a canonical link. */
const embedOf = (canonical: string): string =>
  `https://www.figma.com/embed?embed_host=standupless&url=${encodeURIComponent(canonical)}`;

describe('parseFigmaLink', () => {
  it.each([
    [
      `https://www.figma.com/design/${KEY}/My-File?node-id=12-34&t=abc-0`,
      `https://www.figma.com/design/${KEY}?node-id=12-34`,
      '12-34',
    ],
    [
      `https://www.figma.com/file/${KEY}/Old-File?node-id=12%3A34`,
      `https://www.figma.com/file/${KEY}?node-id=12-34`,
      '12-34',
    ],
    [
      `https://figma.com/proto/${KEY}/Flow?node-id=1-2&scaling=min-zoom`,
      `https://www.figma.com/proto/${KEY}?node-id=1-2`,
      '1-2',
    ],
    [
      `https://www.figma.com/board/${KEY}/Jam`,
      `https://www.figma.com/board/${KEY}`,
      null,
    ],
    [
      `https://www.figma.com/design/${KEY}`,
      `https://www.figma.com/design/${KEY}`,
      null,
    ],
  ])('reads %s', (link, canonicalUrl, nodeId) => {
    expect(parseFigmaLink(new URL(link))).toEqual({
      id: KEY,
      kind: expect.any(String) as string,
      nodeId,
      canonicalUrl,
      embedUrl: embedOf(canonicalUrl),
    });
  });

  it('drops an odd node-id to the whole file', () => {
    const found = parseFigmaLink(
      new URL(`https://www.figma.com/design/${KEY}/x?node-id=1-2"onload=x`)
    );
    expect(found?.nodeId).toBeNull();
    expect(found?.canonicalUrl).toBe(`https://www.figma.com/design/${KEY}`);
  });

  it.each([
    `http://www.figma.com/design/${KEY}/x`,
    `https://figma.com.evil.example/design/${KEY}/x`,
    `https://evilfigma.com/design/${KEY}/x`,
    `https://help.figma.com/design/${KEY}/x`,
    `https://www.figma.com/community/file/${KEY}`,
    `https://www.figma.com/files/recent`,
    `https://www.figma.com/design/short/x`,
    `https://www.figma.com/design/${KEY.slice(0, 5)}<script>/x`,
    'https://www.figma.com/design',
    `https://user:pass@www.figma.com/design/${KEY}/x`,
    `https://www.figma.com:8443/design/${KEY}/x`,
  ])('leaves %s a link', (link) => {
    expect(parseFigmaLink(new URL(link))).toBeNull();
  });
});

describe('Figma links as embeds', () => {
  const url = `https://www.figma.com/design/${KEY}/My-File?node-id=12-34`;

  it('parses as a figma embed keeping the link as written', () => {
    expect(parseVideoEmbed(url)).toEqual({
      provider: 'figma',
      id: KEY,
      url,
      embedUrl: embedOf(`https://www.figma.com/design/${KEY}?node-id=12-34`),
    });
  });

  it('allows the Figma origin in frame-src and no wider host', () => {
    expect(VIDEO_EMBED_ORIGINS).toContain('https://www.figma.com');
    expect(VIDEO_EMBED_ORIGINS.some((origin) => origin.includes('*'))).toBe(
      false
    );
  });

  it('reads a bare Figma link alone in its paragraph as an embed', () => {
    const blocks = parseMarkdown(`intro\n\n${url}\n\noutro`);
    expect(blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'embed',
      'paragraph',
    ]);
  });

  it('leaves a Figma link in running text, a list or brackets a link', () => {
    for (const source of [`see ${url}`, `- ${url}`, `[${url}](${url})`]) {
      expect(
        parseMarkdown(source).some((block) => block.type === 'embed')
      ).toBe(false);
    }
  });
});
