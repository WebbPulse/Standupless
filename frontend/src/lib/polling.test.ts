/**
 * Notice covered polls stretch only while the change socket is healthy.
 */

import { describe, expect, it } from 'vitest';
import { REALTIME_POLL_FACTOR, relaxedPollMs } from './polling';

describe('relaxedPollMs', () => {
  it('keeps the base interval without a healthy socket', () => {
    expect(relaxedPollMs(30000, false)).toBe(30000);
  });

  it('stretches the interval while the socket is healthy', () => {
    expect(relaxedPollMs(30000, true)).toBe(30000 * REALTIME_POLL_FACTOR);
  });
});
