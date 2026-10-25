/**
 * The panel beside the Pulse feed on wide screens: each project and
 * initiative the loaded feed is about, most recently active first, with the
 * health it last reported and how many entries it has in the feed. It stays
 * in view while the feed scrolls and is left out below the xl breakpoint,
 * where the feed takes the whole column.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { HealthPill } from '../../components/planning/ProjectUpdateCard';
import type { ProjectHealth, PulseItemRead } from '../../types/Api';
import { SubjectMark } from './PulseEntry';
import { subjectHref, subjectName } from './pulseDisplay';

/** How many sources the panel lists at most. */
const SOURCE_LIMIT = 12;

/** One project or initiative the feed is about. */
export interface PulseSource {
  key: string;
  item: PulseItemRead;
  name: string;
  health: ProjectHealth | null;
  count: number;
  healthKnown: boolean;
}

/** Whether an entry says what its subject's health is; a completed milestone does not. */
const reportsHealth = (item: PulseItemRead): boolean =>
  item.event_type !== 'milestone_completed';

/** The feed's sources in order of their newest entry, each with the health its newest health-bearing entry reported and its entry count. */
export const pulseSources = (items: PulseItemRead[]): PulseSource[] => {
  const sources = new Map<string, PulseSource>();
  for (const item of items) {
    const id =
      item.subject_type === 'initiative' ? item.initiative_id : item.project_id;
    if (id === null) continue;
    const key = `${item.subject_type}:${id}`;
    const known = sources.get(key);
    if (known === undefined) {
      sources.set(key, {
        key,
        item,
        name: subjectName(item),
        health: item.health,
        count: 1,
        healthKnown: reportsHealth(item),
      });
      continue;
    }
    known.count += 1;
    if (!known.healthKnown && reportsHealth(item)) {
      known.health = item.health;
      known.healthKnown = true;
    }
  }
  return [...sources.values()];
};

/** Props for PulseSidePanel. */
export interface PulseSidePanelProps {
  items: PulseItemRead[];
  slug: string;
}

/** The sources panel shown beside the feed from the xl breakpoint up. */
export const PulseSidePanel: React.FC<PulseSidePanelProps> = ({
  items,
  slug,
}) => {
  const sources = pulseSources(items);
  if (sources.length === 0) return null;
  const shown = sources.slice(0, SOURCE_LIMIT);
  return (
    <aside aria-label="In this feed" className="hidden w-72 shrink-0 xl:block">
      <div className="sticky top-0 pt-6">
        <h2 className="pb-3 text-xs font-medium text-text-muted">
          In this feed
        </h2>
        <ul className="flex flex-col gap-0.5">
          {shown.map((source) => {
            const href = subjectHref(slug, source.item);
            return (
              <li
                key={source.key}
                className="flex h-8 min-w-0 items-center gap-2 rounded-md px-2 transition-colors duration-100 hover:bg-raised"
              >
                <SubjectMark item={source.item} />
                {href === '' ? (
                  <span className="min-w-0 flex-1 truncate text-sm text-text">
                    {source.name}
                  </span>
                ) : (
                  <Link
                    to={href}
                    className="min-w-0 flex-1 truncate rounded-xs text-sm text-text hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    {source.name}
                  </Link>
                )}
                {source.health !== null && (
                  <HealthPill health={source.health} />
                )}
                <span className="w-5 shrink-0 text-right text-xs text-text-faint tabular-nums">
                  <span aria-hidden="true">{source.count}</span>
                  <span className="sr-only">
                    {`${source.count} ${source.count === 1 ? 'entry' : 'entries'}`}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
        {sources.length > shown.length && (
          <p className="px-2 pt-2 text-xs text-text-faint">
            {`and ${sources.length - shown.length} more`}
          </p>
        )}
      </div>
    </aside>
  );
};

export default PulseSidePanel;
