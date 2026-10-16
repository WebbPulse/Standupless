/**
 * The SCIM block. It shows the base URL and the live tokens, shows a new
 * token's secret once after minting it, and revokes a token from the list.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ScimSettingsRead,
  ScimTokenCreated,
  ScimTokenRead,
} from '../../types/Api';
import ScimBlock from './ScimBlock';

const getScimSettings = vi.fn<() => Promise<ScimSettingsRead>>();
const createScimToken = vi.fn<(name: string) => Promise<ScimTokenCreated>>();
const revokeScimToken = vi.fn<(keyId: string) => Promise<void>>();

vi.mock('../../api/workspaces', () => ({
  getScimSettings: () => getScimSettings(),
  createScimToken: (_workspaceId: string, name: string) =>
    createScimToken(name),
  revokeScimToken: (_workspaceId: string, keyId: string) =>
    revokeScimToken(keyId),
}));

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

const BASE_URL = 'https://standupless.example/api/scim/v2';

/** A live token in the shape the contract answers with. */
const token = (over: Partial<ScimTokenRead> = {}): ScimTokenRead => ({
  key_id: 'key-1',
  name: 'Okta',
  prefix: 'wpk_abc12345',
  created_by: 'user-1',
  created_at: '2026-10-16T00:00:00Z',
  last_used_at: null,
  ...over,
});

/** Mounts the block inside a router. */
const renderBlock = () =>
  render(
    <MemoryRouter>
      <ScimBlock workspaceId="ws-1" />
    </MemoryRouter>
  );

beforeEach(() => {
  getScimSettings.mockReset();
  createScimToken.mockReset();
  revokeScimToken.mockReset();
});

describe('ScimBlock', () => {
  it('shows the base URL and an empty list', async () => {
    getScimSettings.mockResolvedValue({ base_url: BASE_URL, tokens: [] });
    renderBlock();
    expect(await screen.findByText(BASE_URL)).toBeInTheDocument();
    expect(screen.getByText('No SCIM tokens yet.')).toBeInTheDocument();
  });

  it('shows a minted secret once and lists the token', async () => {
    getScimSettings.mockResolvedValueOnce({ base_url: BASE_URL, tokens: [] });
    getScimSettings.mockResolvedValue({
      base_url: BASE_URL,
      tokens: [token()],
    });
    createScimToken.mockResolvedValue({ ...token(), secret: 'wpk_secret' });
    const user = userEvent.setup();
    renderBlock();
    await screen.findByText(BASE_URL);
    await user.type(screen.getByLabelText('Token name'), 'Okta');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(createScimToken).toHaveBeenCalledWith('Okta');
    expect(await screen.findByText('wpk_secret')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('wpk_secret')).not.toBeInTheDocument();
    expect(await screen.findByText('wpk_abc12345')).toBeInTheDocument();
  });

  it('revokes a token from the list', async () => {
    getScimSettings.mockResolvedValueOnce({
      base_url: BASE_URL,
      tokens: [token()],
    });
    getScimSettings.mockResolvedValue({ base_url: BASE_URL, tokens: [] });
    revokeScimToken.mockResolvedValue();
    const user = userEvent.setup();
    renderBlock();
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(revokeScimToken).toHaveBeenCalledWith('key-1');
    await waitFor(() => {
      expect(screen.getByText('No SCIM tokens yet.')).toBeInTheDocument();
    });
  });
});
