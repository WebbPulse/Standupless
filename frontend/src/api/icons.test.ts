/**
 * The icon contract: each owner's base path, the three calls that hang off
 * it, and the order an upload runs in. A wrong path or verb type-checks the
 * same as the right one and only fails against a live backend, so each is
 * pinned here, as is the local refusal that mirrors the server's rules.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AVATAR_PATH,
  avatarIcon,
  describeIconRefusal,
  MAX_ICON_BYTES,
  teamIcon,
  teamIconPath,
  uploadIcon,
  workspaceIcon,
  workspaceIconPath,
} from './icons';

const calls: string[] = [];
const post =
  vi.fn<(path: string, body?: unknown) => Promise<{ data: unknown }>>();
const put =
  vi.fn<(path: string, body?: unknown) => Promise<{ data: unknown }>>();
const del = vi.fn<(path: string) => Promise<{ data: unknown }>>();
const putUploadBytes = vi.fn<(ticket: unknown, file: Blob) => Promise<void>>();

vi.mock('./client', () => ({
  default: {
    post: (path: string, body?: unknown) => post(path, body),
    put: (path: string, body?: unknown) => put(path, body),
    delete: (path: string) => del(path),
  },
}));

vi.mock('./discussion', () => ({
  putUploadBytes: (ticket: unknown, file: Blob) => putUploadBytes(ticket, file),
}));

/** A file of a given type and size, without allocating the bytes. */
const fileOf = (type: string, size = 10): File => {
  const file = new File(['x'], 'icon', { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

beforeEach(() => {
  calls.length = 0;
  post.mockReset().mockImplementation((path) => {
    calls.push(`POST ${path}`);
    return Promise.resolve({
      data: { upload_id: 'u'.repeat(22), url: 'https://s3/put', headers: {} },
    });
  });
  putUploadBytes.mockReset().mockImplementation(() => {
    calls.push('PUT bytes');
    return Promise.resolve();
  });
  put.mockReset().mockImplementation((path) => {
    calls.push(`PUT ${path}`);
    return Promise.resolve({ data: { id: 'owner', icon_url: 'https://i' } });
  });
  del.mockReset().mockResolvedValue({ data: { id: 'owner', icon_url: null } });
});

describe('icon paths', () => {
  it('hangs each owner off its own base path', () => {
    expect(AVATAR_PATH).toBe('/users/me/avatar');
    expect(workspaceIconPath('ws-1')).toBe('/workspaces/ws-1/icon');
    expect(teamIconPath('ws-1', 't-1')).toBe('/workspaces/ws-1/teams/t-1/icon');
  });
});

describe('uploadIcon', () => {
  it('signs, sends the bytes, then commits the upload id', async () => {
    const file = fileOf('image/png', 1234);
    const owner = await uploadIcon(workspaceIcon('ws-1'), file);

    expect(calls).toEqual([
      'POST /workspaces/ws-1/icon/uploads',
      'PUT bytes',
      'PUT /workspaces/ws-1/icon',
    ]);
    expect(post).toHaveBeenCalledWith('/workspaces/ws-1/icon/uploads', {
      content_type: 'image/png',
      size_bytes: 1234,
    });
    expect(put).toHaveBeenCalledWith('/workspaces/ws-1/icon', {
      upload_id: 'u'.repeat(22),
    });
    expect(owner).toEqual({ id: 'owner', icon_url: 'https://i' });
  });

  it('commits nothing when the bytes fail to upload', async () => {
    putUploadBytes.mockRejectedValueOnce(new Error('network'));
    await expect(uploadIcon(avatarIcon, fileOf('image/png'))).rejects.toThrow(
      'network'
    );
    expect(put).not.toHaveBeenCalled();
  });
});

describe('clear', () => {
  it('deletes each owner base path and answers the owner', async () => {
    await expect(workspaceIcon('ws-1').clear()).resolves.toEqual({
      id: 'owner',
      icon_url: null,
    });
    await teamIcon('ws-1', 't-1').clear();
    await avatarIcon.clear();
    expect(del.mock.calls.map(([path]) => path)).toEqual([
      '/workspaces/ws-1/icon',
      '/workspaces/ws-1/teams/t-1/icon',
      '/users/me/avatar',
    ]);
  });
});

describe('team and avatar uploads', () => {
  it('sign and commit under their own base paths', async () => {
    await uploadIcon(teamIcon('ws-1', 't-1'), fileOf('image/gif'));
    await uploadIcon(avatarIcon, fileOf('image/jpeg'));
    expect(calls).toEqual([
      'POST /workspaces/ws-1/teams/t-1/icon/uploads',
      'PUT bytes',
      'PUT /workspaces/ws-1/teams/t-1/icon',
      'POST /users/me/avatar/uploads',
      'PUT bytes',
      'PUT /users/me/avatar',
    ]);
  });
});

describe('describeIconRefusal', () => {
  it('accepts the four image types up to the cap', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(describeIconRefusal(fileOf(type, MAX_ICON_BYTES))).toBeNull();
    }
  });

  it('refuses SVG and other types', () => {
    expect(describeIconRefusal(fileOf('image/svg+xml'))).toMatch(/PNG, JPEG/);
    expect(describeIconRefusal(fileOf('text/html'))).toMatch(/PNG, JPEG/);
  });

  it('refuses a file over 2 MB', () => {
    expect(describeIconRefusal(fileOf('image/png', MAX_ICON_BYTES + 1))).toBe(
      'Choose an image of 2 MB or less.'
    );
  });
});
