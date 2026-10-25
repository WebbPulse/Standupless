/** Tests for the rules a Resources link is typed and read by. */

import { describe, expect, it } from 'vitest';
import { linkLabel, normalisedUrl, webUrl } from './projectLinks';

describe('webUrl', () => {
  it('takes http and https addresses with a host', () => {
    expect(webUrl('https://example.com/spec')?.hostname).toBe('example.com');
    expect(webUrl('  http://example.com  ')?.hostname).toBe('example.com');
  });

  it('refuses any other scheme or a missing host', () => {
    for (const value of [
      '',
      'example.com',
      'ftp://example.com',
      'javascript:alert(1)',
      'mailto:someone@example.com',
      'https://',
    ]) {
      expect(webUrl(value)).toBeNull();
    }
  });
});

describe('normalisedUrl', () => {
  it('puts https in front of a bare address and keeps a named scheme', () => {
    expect(normalisedUrl(' example.com/spec ')).toBe(
      'https://example.com/spec'
    );
    expect(normalisedUrl('http://example.com')).toBe('http://example.com');
    expect(normalisedUrl('javascript:alert(1)')).toBe('javascript:alert(1)');
  });
});

describe('linkLabel', () => {
  it('reads the title, or the hostname without one', () => {
    expect(linkLabel({ url: 'https://example.com/a', title: 'Spec' })).toBe(
      'Spec'
    );
    expect(linkLabel({ url: 'https://docs.example.com/a', title: null })).toBe(
      'docs.example.com'
    );
    expect(linkLabel({ url: 'https://example.com/a', title: '  ' })).toBe(
      'example.com'
    );
  });
});
