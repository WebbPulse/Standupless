/**
 * The settings pages the command palette can open, with the words each one is
 * found by. They are read from the settings index the settings search uses,
 * so a settings page or control added there is found here too.
 *
 * The rows the palette already offers among its places, Edit profile,
 * Preferences, Security & access, Manage teams and the MCP and CLI setup, are not repeated. A row
 * that is admin only on the settings nav is admin only here too, so the
 * palette never opens a page that would only say the caller may not see it.
 */

import { fuzzyMatch } from './fuzzyMatch';
import { teamSettingsSectionPath } from './paths';
import { teamSettingsSectionsFor, visibleSettingsPages } from './settingsIndex';
import type { WorkspaceRead } from '../types/Api';

/** One page the palette can go to. */
export interface PaletteDestination {
  /** Stable within its list, so the palette can key its row on it. */
  id: string;
  label: string;
  /** The words the row is found by beyond its label. */
  keywords: string;
  to: string;
}

/** The words a row is found by: its own synonyms, then the titles and synonyms of what it holds. */
const keywordsOf = (
  synonyms: readonly string[],
  children: readonly { title: string; synonyms?: readonly string[] }[]
): string =>
  [
    ...synonyms,
    ...children.flatMap((child) => [child.title, ...(child.synonyms ?? [])]),
    'settings',
  ].join(' ');

/**
 * The workspace and personal settings pages the caller may open, read from
 * the settings index so a section or control on a page finds the page too.
 */
export const settingsDestinations = (
  workspace: Pick<WorkspaceRead, 'slug' | 'role'>
): PaletteDestination[] =>
  visibleSettingsPages(workspace.role).flatMap((page) =>
    page.paletteLabel === undefined
      ? []
      : [
          {
            id: page.id,
            label: page.paletteLabel,
            keywords: keywordsOf(page.synonyms, page.items ?? []),
            to: page.path(workspace.slug),
          },
        ]
  );

/**
 * The sections of one team's settings page, each opening on its anchor and
 * found by the controls it holds, so "cooldown" lands on the cycle settings.
 */
export const teamSettingsDestinations = (
  slug: string,
  keyPrefix: string,
  features?: WorkspaceRead['features']
): PaletteDestination[] =>
  teamSettingsSectionsFor(features).map((section) => ({
    id: section.id,
    label: section.paletteLabel,
    keywords: keywordsOf(section.synonyms, section.controls ?? []),
    to: teamSettingsSectionPath(slug, keyPrefix, section.id),
  }));

/**
 * Whether every word of the term lands in one of the texts, case blind, so
 * "team sla" finds a row whose label says SLA and whose keywords say team.
 * The first text is the label; matching is the palette's deterministic fuzzy
 * scorer, so "notif" and "ntoif" both find Notification settings.
 */
export const matchesTerm = (texts: readonly string[], term: string): boolean =>
  fuzzyMatch(texts[0] ?? '', texts.slice(1), term).score > 0;
