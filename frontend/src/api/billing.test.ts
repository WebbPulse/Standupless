/**
 * The billing contract: each route's path and verb, and that the session
 * calls answer the bare URL the page sends the browser to.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCheckoutSession,
  createPortalSession,
  getBilling,
  getStorageUsage,
} from './billing';

const get =
  vi.fn<(path: string, options?: unknown) => Promise<{ data: unknown }>>();
const post =
  vi.fn<(path: string, body?: unknown) => Promise<{ data: unknown }>>();

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
    post: (path: string, body?: unknown) => post(path, body),
  },
}));

beforeEach(() => {
  get.mockReset().mockResolvedValue({ data: { plan: 'free' } });
  post.mockReset().mockResolvedValue({ data: { url: 'https://stripe/x' } });
});

describe('the billing routes', () => {
  it('reads the plan and the storage usage', async () => {
    await getBilling('ws-1');
    await getStorageUsage('ws-1');
    expect(get.mock.calls.map(([path]) => path)).toEqual([
      '/workspaces/ws-1/billing',
      '/workspaces/ws-1/attachments/usage',
    ]);
  });

  it('starts Checkout with the plan and interval and answers the URL', async () => {
    const url = await createCheckoutSession('ws-1', {
      plan: 'standard',
      interval: 'month',
    });
    expect(url).toBe('https://stripe/x');
    expect(post).toHaveBeenCalledWith(
      '/workspaces/ws-1/billing/checkout-session',
      { plan: 'standard', interval: 'month' }
    );
  });

  it('opens the portal and answers the URL', async () => {
    expect(await createPortalSession('ws-1')).toBe('https://stripe/x');
    expect(post).toHaveBeenCalledWith(
      '/workspaces/ws-1/billing/portal-session',
      undefined
    );
  });
});
