/**
 * The optional workspace areas an admin can turn off from Settings, Features.
 * Every area is on unless the workspace says otherwise, so a workspace read
 * before the setting existed shows everything. Turning an area off hides it
 * from navigation, pickers and menus, while its data is kept and the server
 * refuses writes to it.
 */

import type {
  SidebarItem,
  WorkspaceFeature,
  WorkspaceFeatures,
  WorkspaceRead,
} from '../types/Api';

/** One area as the Features settings page lists it. */
export interface FeatureInfo {
  feature: WorkspaceFeature;
  label: string;
  description: string;
}

/** Every area in the order the Features settings page lists them. */
export const FEATURES: FeatureInfo[] = [
  {
    feature: 'initiatives',
    label: 'Initiatives',
    description: 'Group projects under company goals and track their progress.',
  },
  {
    feature: 'customers',
    label: 'Customers',
    description: 'Record customer requests and link them to issues.',
  },
  {
    feature: 'releases',
    label: 'Releases',
    description: 'Plan what ships together and follow each release to done.',
  },
  {
    feature: 'documents',
    label: 'Documents',
    description: 'Write specs and notes alongside projects and initiatives.',
  },
  {
    feature: 'pulse',
    label: 'Pulse',
    description:
      'A feed of updates from the projects and initiatives you follow.',
  },
];

/** The words an area reads as. */
export const featureLabel = (feature: WorkspaceFeature): string =>
  FEATURES.find((row) => row.feature === feature)?.label ?? feature;

/** Whether the workspace has an area on, true for a workspace that does not say. */
export const isFeatureOn = (
  workspace: Pick<WorkspaceRead, 'features'> | null | undefined,
  feature: WorkspaceFeature
): boolean => workspace?.features?.[feature] !== false;

/** Every area's setting, with any area the workspace does not name read as on. */
export const resolveFeatures = (
  workspace: Pick<WorkspaceRead, 'features'> | null | undefined
): WorkspaceFeatures => ({
  initiatives: isFeatureOn(workspace, 'initiatives'),
  customers: isFeatureOn(workspace, 'customers'),
  releases: isFeatureOn(workspace, 'releases'),
  documents: isFeatureOn(workspace, 'documents'),
  pulse: isFeatureOn(workspace, 'pulse'),
});

/** The area a sidebar item belongs to, or null for an item that is always there. */
export const featureOfSidebarItem = (
  item: SidebarItem
): WorkspaceFeature | null =>
  item === 'pulse' || item === 'initiatives' || item === 'customers'
    ? item
    : null;
