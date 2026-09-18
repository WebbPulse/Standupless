/**
 * The unread badge. Covers that it reads the count route rather than the list,
 * that it shows nothing at zero rather than an empty circle, and that it
 * renders the saturation the contract caps the count at.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InboxBadge from './InboxBadge';

const getInboxCount = vi.fn<() => Promise<number>>();
const listInbox = vi.fn<() => Promise<never>>();

vi.mock('../../api/views', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/views')>('../../api/views');
  return {
    ...actual,
    getInboxCount: () => getInboxCount(),
    listInbox: () => listInbox(),
  };
});

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

beforeEach(() => {
  getInboxCount.mockReset();
  listInbox.mockReset();
  getInboxCount.mockResolvedValue(3);
});

describe('inbox badge', () => {
  it('shows the unread count', async () => {
    render(<InboxBadge workspaceId="ws-1" />);

    expect(await screen.findByText('3')).toBeInTheDocument();
  });

  it('counts through the count route rather than reading the list', async () => {
    render(<InboxBadge workspaceId="ws-1" />);

    await waitFor(() => {
      expect(getInboxCount).toHaveBeenCalled();
    });
    expect(listInbox).not.toHaveBeenCalled();
  });

  it('shows nothing at all when there is nothing unread', async () => {
    getInboxCount.mockResolvedValue(0);
    const { container } = render(<InboxBadge workspaceId="ws-1" />);

    await waitFor(() => {
      expect(getInboxCount).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('saturates rather than printing the raw count', async () => {
    getInboxCount.mockResolvedValue(100);
    render(<InboxBadge workspaceId="ws-1" />);

    expect(await screen.findByText('99+')).toBeInTheDocument();
  });

  it('names the count for a screen reader', async () => {
    render(<InboxBadge workspaceId="ws-1" />);

    expect(await screen.findByLabelText('3 unread')).toBeInTheDocument();
  });

  it('does not read before the workspace is known', async () => {
    render(<InboxBadge workspaceId="" />);

    await waitFor(() => {
      expect(getInboxCount).not.toHaveBeenCalled();
    });
  });
});
