/**
 * The caller's sidebar customization: where each item sits and how the unread
 * badges draw. A change shows at once on the signed in account and is saved to
 * it, so it follows the person to every device; a refused save puts the last
 * saved layout back and says so.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { updatePreferences } from '../api/notifications';
import { CURRENT_USER_KEY } from '../lib/queryKeys';
import { resolveSidebarItems } from '../lib/sidebarItems';
import { showErrorToast } from '../lib/toast';
import type {
  SidebarBadgeStyle,
  SidebarItem,
  SidebarVisibility,
  UserRead,
} from '../types/Api';
import { useAuth } from './useAuth';

/** What {@link useSidebarPreference} hands back. */
export interface SidebarPreference {
  items: Record<SidebarItem, SidebarVisibility>;
  badgeStyle: SidebarBadgeStyle;
  /** Moves one item to a new place. */
  place: (item: SidebarItem, visibility: SidebarVisibility) => void;
  setBadgeStyle: (style: SidebarBadgeStyle) => void;
}

/** The signed in person's sidebar layout, with changes that save to the account. */
export const useSidebarPreference = (): SidebarPreference => {
  const { user, login } = useAuth();
  const latest = useRef<UserRead | null>(user);
  useEffect(() => {
    latest.current = user;
  }, [user]);

  const items = useMemo(
    () => resolveSidebarItems(user?.sidebar_items),
    [user?.sidebar_items]
  );
  const badgeStyle = user?.sidebar_badge_style ?? 'count';

  const save = useCallback(
    (
      optimistic: (held: UserRead) => UserRead,
      send: Parameters<typeof updatePreferences>[0]
    ) => {
      const held = latest.current;
      if (held === null) return;
      const shown = optimistic(held);
      latest.current = shown;
      login(shown);
      void updatePreferences(send)
        .then((answer) => {
          latest.current = answer;
          login(answer);
          invalidateQueries(CURRENT_USER_KEY);
        })
        .catch(() => {
          latest.current = held;
          login(held);
          showErrorToast('Could not save the sidebar to your account.');
        });
    },
    [login]
  );

  const place = useCallback(
    (item: SidebarItem, visibility: SidebarVisibility) => {
      save(
        (held) => ({
          ...held,
          sidebar_items: {
            ...resolveSidebarItems(held.sidebar_items),
            [item]: visibility,
          },
        }),
        { sidebar_items: { [item]: visibility } }
      );
    },
    [save]
  );

  const setBadgeStyle = useCallback(
    (style: SidebarBadgeStyle) => {
      save((held) => ({ ...held, sidebar_badge_style: style }), {
        sidebar_badge_style: style,
      });
    },
    [save]
  );

  return { items, badgeStyle, place, setBadgeStyle };
};

export default useSidebarPreference;
