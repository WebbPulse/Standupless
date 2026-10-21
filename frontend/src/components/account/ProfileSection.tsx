/**
 * The signed in person's name, Linear style: a full name for how they are
 * written about, and a username that is the `@handle` teammates mention them
 * by and the name shown beside their work. A username must be free in every
 * workspace the person belongs to, so a clash is refused with the server's
 * sentence. Saving swaps the signed in user in place and re-reads the member
 * lists, so every list, mention and card picks up the new name without
 * signing in again. Old mentions keep pointing at the same person.
 */

import React, { useEffect, useId, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { updateProfile } from '../../api/profile';
import { useAuth } from '../../hooks/useAuth';
import { USERNAME_PATTERN } from '../../lib/account';
import { errorMessage } from '../../lib/errors';
import {
  CURRENT_USER_KEY,
  membersKey,
  teamMembersKey,
} from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import type { UserProfileUpdate } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Field from '../ui/field';

/** The most characters a full name holds. */
const FULL_NAME_MAX = 120;

/** Props for ProfileSection: the lists to re-read once a name changes. */
export interface ProfileSectionProps {
  /** The workspace whose member list shows the name, when inside one. */
  workspaceId?: string;
  /** The teams whose member lists show the name, when inside a workspace. */
  teamIds?: string[];
}

/** The fields that differ from what is stored, or null when nothing does. */
const changesFrom = (
  stored: { fullName: string; username: string },
  draft: { fullName: string; username: string }
): UserProfileUpdate | null => {
  const body: UserProfileUpdate = {};
  const fullName = draft.fullName.trim().replace(/\s+/g, ' ');
  if (fullName !== stored.fullName) body.full_name = fullName;
  const username = draft.username.trim();
  if (username !== stored.username) body.display_name = username;
  return Object.keys(body).length === 0 ? null : body;
};

/** Edits the caller's full name and username. */
export const ProfileSection: React.FC<ProfileSectionProps> = ({
  workspaceId,
  teamIds = [],
}) => {
  const { user, login } = useAuth();
  const stored = {
    fullName: user?.full_name ?? '',
    username: user?.display_name ?? '',
  };
  const [fullName, setFullName] = useState(stored.fullName);
  const [username, setUsername] = useState(stored.username);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fullNameId = useId();
  const usernameId = useId();

  useEffect(() => {
    setFullName(stored.fullName);
    setUsername(stored.username);
  }, [stored.fullName, stored.username]);

  if (user === null) return null;

  const changes = changesFrom(stored, { fullName, username });
  const usernameValid =
    username.trim() === stored.username ||
    USERNAME_PATTERN.test(username.trim());

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (changes === null || !usernameValid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await updateProfile(changes);
      login(saved);
      invalidateQueries([
        CURRENT_USER_KEY,
        ...(workspaceId === undefined ? [] : [membersKey(workspaceId)]),
        ...teamIds.map((id) => teamMembersKey(id)),
      ]);
      showToast('Profile saved.');
    } catch (failure) {
      setError(errorMessage(failure, 'Could not save your profile.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4" aria-labelledby="profile-title">
      <div className="space-y-1">
        <h2 id="profile-title" className="text-base font-semibold">
          Profile
        </h2>
        <p className="text-sm text-text-muted">
          How you appear to teammates in every workspace you belong to.
        </p>
      </div>
      <form
        className="space-y-4 rounded-md border border-line p-4"
        onSubmit={(event) => void save(event)}
      >
        <Field
          id={fullNameId}
          label="Full name"
          value={fullName}
          maxLength={FULL_NAME_MAX}
          autoComplete="name"
          onChange={(event) => setFullName(event.target.value)}
          disabled={saving}
        />
        <Field
          id={usernameId}
          label="Username"
          value={username}
          maxLength={39}
          autoComplete="username"
          aria-invalid={!usernameValid}
          hint="One word, used to @mention you and shown beside your work. Letters, numbers, hyphens and underscores."
          onChange={(event) => setUsername(event.target.value)}
          disabled={saving}
        />
        {!usernameValid && (
          <ErrorAlert message="A username starts with a letter or number and holds only letters, numbers, hyphens and underscores, up to 39 characters." />
        )}
        <ErrorAlert message={error} />
        <div className="flex justify-end">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={saving || changes === null || !usernameValid}
          >
            Save
          </Button>
        </div>
      </form>
    </section>
  );
};

export default ProfileSection;
