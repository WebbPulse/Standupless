/**
 * The signed in person's avatar: the picture teammates see beside their name
 * in member lists, assignees and comments, in every workspace they belong to.
 */

import React from 'react';
import { avatarIcon, uploadIcon } from '../../api/icons';
import { useAuth } from '../../hooks/useAuth';
import IconUploader from '../ui/icon-uploader';

/** Uploads, replaces or removes the caller's avatar and updates the signed in user. */
export const AvatarPanel: React.FC = () => {
  const { user, login } = useAuth();
  if (user === null) return null;

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Avatar</h2>
        <p className="text-sm text-text-muted">
          A square image works best. PNG, JPEG, GIF or WebP, up to 2 MB.
        </p>
      </div>
      <IconUploader
        label="Your avatar"
        description="Shown beside your name in every workspace you belong to."
        name={user.display_name ?? user.email}
        src={user.avatar_url}
        shape="circle"
        canEdit
        onUpload={async (file) => {
          login(await uploadIcon(avatarIcon, file));
        }}
        onRemove={async () => {
          login(await avatarIcon.clear());
        }}
      />
    </section>
  );
};

export default AvatarPanel;
