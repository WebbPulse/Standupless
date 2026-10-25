/**
 * The change socket URL only takes a WebSocket URL, so a mistyped variable
 * leaves the build on polling rather than opening something else.
 */

import { describe, expect, it } from 'vitest';
import { parseRealtimeUrl } from './app';

describe('parseRealtimeUrl', () => {
  it('takes a wss URL and trims a trailing slash', () => {
    expect(
      parseRealtimeUrl(
        ' wss://abc.execute-api.us-west-2.amazonaws.com/staging/ '
      )
    ).toBe('wss://abc.execute-api.us-west-2.amazonaws.com/staging');
  });

  it('takes a local ws URL', () => {
    expect(parseRealtimeUrl('ws://localhost:3001')).toBe('ws://localhost:3001');
  });

  it.each([undefined, '', 'https://example.com', 'wss://host/path?token=x', 3])(
    'refuses %s',
    (value) => {
      expect(parseRealtimeUrl(value)).toBe('');
    }
  );
});
