/**
 * One Pulse entry as its own card: who did it and when on the first line,
 * what it is about with its health on the second, then the update itself,
 * clamped to a few paragraphs with a toggle to read the rest. The first line
 * ends in the overflow menu the feed hands in.
 */

import React, { useLayoutEffect, useRef, useState } from 'react';
import { LuActivity, LuFlag, LuGoal } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { HealthPill } from '../../components/planning/ProjectUpdateCard';
import ProjectIcon from '../../components/planning/ProjectIcon';
import Avatar from '../../components/ui/avatar';
import Markdown from '../../components/ui/markdown';
import RelativeTime from '../../components/ui/relative-time';
import ViaSource from '../../components/ui/via-source';
import { cn } from '../../lib/cn';
import type { PulseItemRead } from '../../types/Api';
import { describeEvent, entryHref, subjectName, summary } from './pulseDisplay';

/** The mark beside what an entry is about: the project's own icon, or a goal. */
const SubjectMark: React.FC<{ item: PulseItemRead }> = ({ item }) =>
  item.subject_type === 'initiative' ? (
    <span
      aria-hidden="true"
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-raised text-text-muted"
    >
      <LuGoal className="h-3.5 w-3.5" />
    </span>
  ) : (
    <ProjectIcon icon={item.project_icon} color={item.project_color} />
  );

/** The mark in the avatar's place when nobody did it, such as a milestone closing on its own. */
const SystemMark: React.FC<{ item: PulseItemRead }> = ({ item }) => (
  <span
    aria-hidden="true"
    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line bg-raised text-text-muted"
  >
    {item.event_type === 'milestone_completed' ? (
      <LuFlag className="h-3.5 w-3.5" />
    ) : (
      <LuActivity className="h-3.5 w-3.5" />
    )}
  </span>
);

/** An update body cut to a fixed height, with Show more once it overflows. */
const ClampedBody: React.FC<{ source: string }> = ({ source }) => {
  const box = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const node = box.current;
    if (node === null || expanded) return;
    const measure = (): void => {
      setOverflows(node.scrollHeight > node.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [source, expanded]);

  const clamped = !expanded;
  return (
    <div className="mt-3">
      <div
        ref={box}
        className={cn(
          clamped && 'max-h-60 overflow-hidden',
          clamped &&
            overflows &&
            '[mask-image:linear-gradient(to_bottom,black_70%,transparent)]'
        )}
      >
        <Markdown source={source} className="text-sm text-text" />
      </div>
      {(overflows || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((current) => !current);
          }}
          className="mt-1.5 rounded-sm text-xs font-medium text-text-muted transition-colors duration-100 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
};

/** Props for PulseEntry. */
export interface PulseEntryProps {
  item: PulseItemRead;
  slug: string;
  /** Whether the keyboard highlight is on this entry. */
  active: boolean;
  /** Takes the entry's element, so the keyboard highlight can scroll to it. */
  entryRef: (node: HTMLElement | null) => void;
  /** Moves the keyboard highlight here when the pointer arrives. */
  onPointerEnter: () => void;
  /** The overflow menu drawn at the end of the first line. */
  menu?: React.ReactNode;
}

/** One feed entry as a card: actor and time, subject and health, then the update. */
export const PulseEntry: React.FC<PulseEntryProps> = ({
  item,
  slug,
  active,
  entryRef,
  onPointerEnter,
  menu,
}) => {
  const actor = item.actor_name === '' ? null : item.actor_name;
  const href = entryHref(slug, item);
  const name = subjectName(item);
  const isUpdate =
    item.event_type === 'project_update' ||
    item.event_type === 'initiative_update';
  const body = isUpdate && item.body !== null ? item.body.trim() : '';
  return (
    <article
      ref={entryRef}
      aria-label={`${name}: ${summary(item)}`}
      aria-current={active ? 'true' : undefined}
      data-unread={item.unread ? 'true' : undefined}
      onPointerEnter={onPointerEnter}
      className={cn(
        'scroll-my-12 rounded-lg border bg-surface px-4 shadow-xs transition-colors duration-100 sm:px-5',
        body === '' ? 'py-3' : 'py-4',
        active ? 'border-line-strong bg-raised/40' : 'border-line'
      )}
    >
      <header className="flex min-w-0 items-center gap-2.5">
        {actor !== null ? (
          <Avatar name={actor} size="md" />
        ) : (
          <SystemMark item={item} />
        )}
        <p className="min-w-0 flex-1 truncate text-sm text-text-muted">
          {actor !== null && (
            <span className="font-medium text-text">{actor}</span>
          )}
          {actor !== null ? ` ${describeEvent(item)}` : summary(item)}
        </p>
        <div className="flex shrink-0 items-center gap-2 text-xs text-text-faint">
          <ViaSource source={item.source} />
          {item.edited_at !== null && <span>(edited)</span>}
          <RelativeTime value={item.created_at} />
          {item.unread && (
            <span
              role="img"
              aria-label="Unread"
              className="h-2 w-2 rounded-full bg-accent"
            />
          )}
          {menu}
        </div>
      </header>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-9.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <SubjectMark item={item} />
          {href === '' ? (
            <span className="truncate text-sm font-medium text-text">
              {name}
            </span>
          ) : (
            <Link
              to={href}
              className="truncate rounded-xs text-sm font-medium text-text hover:underline focus-visible:outline-2 focus-visible:outline-accent"
            >
              {name}
            </Link>
          )}
        </span>
        {item.health !== null && <HealthPill health={item.health} />}
      </div>
      {body !== '' && (
        <div className="pl-9.5">
          <ClampedBody source={body} />
        </div>
      )}
    </article>
  );
};

export default PulseEntry;
