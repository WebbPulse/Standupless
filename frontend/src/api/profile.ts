/**
 * The caller's own name and handle. Kept apart from the preference routes
 * because a handle change is checked against every workspace the person
 * belongs to, and it can be refused when someone there already answers to it.
 */

import apiClient from './client';
import type { UserProfileUpdate, UserRead } from '../types/Api';

/** The route the caller's name and handle are changed through. */
export const PROFILE_ROUTE = '/users/me/profile';

/** The code the profile route answers when the handle is someone else's. */
export const HANDLE_TAKEN = 'HANDLE_TAKEN';

/** Saves the fields given and answers the stored profile. */
export const updateProfile = async (
  body: UserProfileUpdate
): Promise<UserRead> => {
  const response = await apiClient.patch<UserRead>(PROFILE_ROUTE, body);
  return response.data;
};
