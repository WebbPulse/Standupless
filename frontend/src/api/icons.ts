/**
 * The icon routes shared by a workspace logo, a team icon and a person's
 * avatar. Each owner has one base path, and the same three calls hang off it:
 * sign an upload, commit it, and clear it. The paths are spelled out here
 * rather than borrowed from the workspace and team modules, so the route
 * contract test can read every one of them. The bytes go straight to the bucket
 * between the first two, exactly as an attachment's do.
 */

import apiClient from './client';
import { putUploadBytes } from './discussion';
import type {
  IconCommit,
  IconUploadCreate,
  IconUploadRead,
  TeamRead,
  UserRead,
  WorkspaceRead,
} from '../types/Api';

/** The image types an icon may be. SVG is refused because it can carry script. */
export const ICON_CONTENT_TYPES: string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

/** The largest icon the presign route signs, in bytes. */
export const MAX_ICON_BYTES = 2 * 1024 * 1024;

/** The base path the caller's own avatar is managed through. */
export const AVATAR_PATH = '/users/me/avatar';

/** The base path a workspace logo is managed through. */
export const workspaceIconPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/icon`;

/** The base path a team icon is managed through. */
export const teamIconPath = (workspaceId: string, teamId: string): string =>
  `/workspaces/${workspaceId}/teams/${teamId}/icon`;

/** Why this file cannot be an icon, or null when the server would accept it. */
export const describeIconRefusal = (file: File): string | null => {
  if (!ICON_CONTENT_TYPES.includes(file.type.toLowerCase())) {
    return 'Choose a PNG, JPEG, GIF or WebP image.';
  }
  if (file.size > MAX_ICON_BYTES) {
    return 'Choose an image of 2 MB or less.';
  }
  return null;
};

/** The three calls one icon owner answers, each returning the owner as it now reads. */
export interface IconEndpoints<T> {
  /** Signs a PUT for one image under the owner's prefix. */
  createUpload: (body: IconUploadCreate) => Promise<IconUploadRead>;
  /** Makes an uploaded image the owner's icon. */
  commit: (body: IconCommit) => Promise<T>;
  /** Removes the owner's icon, bringing the initials back. */
  clear: () => Promise<T>;
}

/** The signed in person's avatar. */
export const avatarIcon: IconEndpoints<UserRead> = {
  createUpload: async (body) =>
    (await apiClient.post<IconUploadRead>(`${AVATAR_PATH}/uploads`, body)).data,
  commit: async (body) =>
    (await apiClient.put<UserRead>(AVATAR_PATH, body)).data,
  clear: async () => (await apiClient.delete<UserRead>(AVATAR_PATH)).data,
};

/** One workspace's logo. */
export const workspaceIcon = (
  workspaceId: string
): IconEndpoints<WorkspaceRead> => ({
  createUpload: async (body) =>
    (
      await apiClient.post<IconUploadRead>(
        `${workspaceIconPath(workspaceId)}/uploads`,
        body
      )
    ).data,
  commit: async (body) =>
    (await apiClient.put<WorkspaceRead>(workspaceIconPath(workspaceId), body))
      .data,
  clear: async () =>
    (await apiClient.delete<WorkspaceRead>(workspaceIconPath(workspaceId)))
      .data,
});

/** One team's icon. */
export const teamIcon = (
  workspaceId: string,
  teamId: string
): IconEndpoints<TeamRead> => ({
  createUpload: async (body) =>
    (
      await apiClient.post<IconUploadRead>(
        `${teamIconPath(workspaceId, teamId)}/uploads`,
        body
      )
    ).data,
  commit: async (body) =>
    (await apiClient.put<TeamRead>(teamIconPath(workspaceId, teamId), body))
      .data,
  clear: async () =>
    (await apiClient.delete<TeamRead>(teamIconPath(workspaceId, teamId))).data,
});

/**
 * Uploads one image as an owner's icon: sign, PUT the bytes to the bucket,
 * then commit. Answers the owner as the commit returned it.
 */
export const uploadIcon = async <T>(
  owner: IconEndpoints<T>,
  file: File
): Promise<T> => {
  const upload = await owner.createUpload({
    content_type: file.type,
    size_bytes: file.size,
  });
  await putUploadBytes(upload, file);
  return owner.commit({ upload_id: upload.upload_id });
};
