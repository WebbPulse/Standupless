/**
 * The workspace sidebar's customizable items and where each sits. A person
 * shows an item in the sidebar, tucks it into the More menu, or hides it; a
 * hidden item is still reached through its `g` shortcut and the command
 * palette. The account keeps only what was moved, so anything unread or never
 * moved reads as shown.
 */

import type {
  SidebarBadgeStyle,
  SidebarItem,
  SidebarVisibility,
  WorkspaceRole,
} from '../types/Api';

/** Every customizable item in sidebar order, with the words it reads as. */
export const SIDEBAR_ITEMS: { item: SidebarItem; label: string }[] = [
  { item: 'home', label: 'Home' },
  { item: 'inbox', label: 'Inbox' },
  { item: 'my_issues', label: 'My issues' },
  { item: 'reviews', label: 'Reviews' },
  { item: 'pulse', label: 'Pulse' },
  { item: 'projects', label: 'Projects' },
  { item: 'initiatives', label: 'Initiatives' },
  { item: 'customers', label: 'Customers' },
  { item: 'views', label: 'Views' },
  { item: 'roadmap', label: 'Roadmap' },
  { item: 'teams', label: 'Your teams' },
];

/** The items in the sidebar's personal section, above Favorites. */
export const PERSONAL_ITEMS: SidebarItem[] = [
  'home',
  'inbox',
  'my_issues',
  'reviews',
  'pulse',
];

/** The items in the sidebar's Workspace section. */
export const WORKSPACE_ITEMS: SidebarItem[] = [
  'projects',
  'initiatives',
  'customers',
  'views',
  'roadmap',
];

/** The places a person may put an item, in the order the dialog offers them. */
export const SIDEBAR_VISIBILITIES: {
  value: SidebarVisibility;
  label: string;
}[] = [
  { value: 'show', label: 'Show' },
  { value: 'more', label: 'In More menu' },
  { value: 'hide', label: 'Hide' },
];

/** The badge styles, in the order the dialog offers them. */
export const SIDEBAR_BADGE_STYLES: {
  value: SidebarBadgeStyle;
  label: string;
}[] = [
  { value: 'count', label: 'Count' },
  { value: 'dot', label: 'Dot' },
];

/** The items a guest never sees, because the pages behind them refuse guests. */
const MEMBER_ONLY: SidebarItem[] = ['initiatives', 'customers'];

const VISIBILITIES = new Set<string>(['show', 'more', 'hide']);

/** Every item's place, `show` for any item the account does not name or names with an unknown place. */
export const resolveSidebarItems = (
  stored: Partial<Record<SidebarItem, string>> | undefined
): Record<SidebarItem, SidebarVisibility> => {
  const resolved = {} as Record<SidebarItem, SidebarVisibility>;
  for (const { item } of SIDEBAR_ITEMS) {
    const place = stored?.[item];
    resolved[item] =
      place !== undefined && VISIBILITIES.has(place)
        ? (place as SidebarVisibility)
        : 'show';
  }
  return resolved;
};

/** Whether an item applies to someone with this workspace role at all. */
export const itemAvailable = (
  item: SidebarItem,
  role: WorkspaceRole | undefined
): boolean => role !== 'guest' || !MEMBER_ONLY.includes(item);

/** The label an item reads as. */
export const sidebarItemLabel = (item: SidebarItem): string =>
  SIDEBAR_ITEMS.find((row) => row.item === item)?.label ?? item;
