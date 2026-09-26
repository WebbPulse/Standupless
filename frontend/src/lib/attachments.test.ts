import { describe, expect, it } from 'vitest';
import { linkHost, normalizeLinkUrl } from './attachments';

describe('normalizeLinkUrl', () => {
  it('keeps a full web address', () => {
    expect(normalizeLinkUrl('https://example.com/a?b=1')).toBe(
      'https://example.com/a?b=1'
    );
  });

  it('adds https to a bare host', () => {
    expect(normalizeLinkUrl('  example.com/page ')).toBe(
      'https://example.com/page'
    );
  });

  it('refuses other schemes and text that is not an address', () => {
    expect(normalizeLinkUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeLinkUrl('mailto:a@b.co')).toBeNull();
    expect(normalizeLinkUrl('not a link')).toBeNull();
    expect(normalizeLinkUrl('word')).toBeNull();
    expect(normalizeLinkUrl('')).toBeNull();
  });
});

describe('linkHost', () => {
  it('drops a leading www', () => {
    expect(linkHost('https://www.example.com/x')).toBe('example.com');
  });

  it('reads nothing from a missing or broken address', () => {
    expect(linkHost(null)).toBe('');
    expect(linkHost('::')).toBe('');
  });
});
