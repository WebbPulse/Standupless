/**
 * The Customize sidebar dialog: every top-level sidebar item with where it
 * sits, shown, in the More menu or hidden, and the style of the unread badges.
 * Each choice applies at once and saves to the account, so there is no save
 * button and closing keeps what was picked.
 */

import React from 'react';
import { useSidebarPreference } from '../../hooks/useSidebarPreference';
import {
  SIDEBAR_BADGE_STYLES,
  SIDEBAR_ITEMS,
  SIDEBAR_VISIBILITIES,
  itemAvailable,
} from '../../lib/sidebarItems';
import type {
  SidebarBadgeStyle,
  SidebarVisibility,
  WorkspaceRole,
} from '../../types/Api';
import Dialog from '../ui/dialog';
import Select from '../ui/select';

/** Props for CustomizeSidebarDialog: the caller's role and how to close it. */
export interface CustomizeSidebarDialogProps {
  open: boolean;
  onClose: () => void;
  /** The caller's workspace role, which decides the items listed. */
  role: WorkspaceRole | undefined;
}

/** Lists each sidebar item with a place picker, then the badge style. */
export const CustomizeSidebarDialog: React.FC<CustomizeSidebarDialogProps> = ({
  open,
  onClose,
  role,
}) => {
  const { items, badgeStyle, place, setBadgeStyle } = useSidebarPreference();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Customize sidebar"
      description="Hidden items stay reachable from the command palette and their keyboard shortcuts."
      size="sm"
    >
      <div className="space-y-4">
        <ul className="space-y-1" aria-label="Sidebar items">
          {SIDEBAR_ITEMS.filter(({ item }) => itemAvailable(item, role)).map(
            ({ item, label }) => (
              <li
                key={item}
                className="flex items-center justify-between gap-3"
              >
                <label
                  htmlFor={`sidebar-item-${item}`}
                  className="text-sm text-text"
                >
                  {label}
                </label>
                <Select
                  id={`sidebar-item-${item}`}
                  className="w-36"
                  value={items[item]}
                  onChange={(event) => {
                    place(item, event.target.value as SidebarVisibility);
                  }}
                >
                  {SIDEBAR_VISIBILITIES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </li>
            )
          )}
        </ul>
        <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
          <label htmlFor="sidebar-badge-style" className="text-sm text-text">
            Badge style
          </label>
          <Select
            id="sidebar-badge-style"
            className="w-36"
            value={badgeStyle}
            onChange={(event) => {
              setBadgeStyle(event.target.value as SidebarBadgeStyle);
            }}
          >
            {SIDEBAR_BADGE_STYLES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
    </Dialog>
  );
};

export default CustomizeSidebarDialog;
