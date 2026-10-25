/**
 * The caller's Pulse, like Linear's: one centred feed of project and
 * initiative updates, health changes and completed milestones, newest first.
 * "For me" holds what the caller leads, is a member of, owns or follows,
 * "Popular" the last two weeks' updates ranked by replies plus reactions, and
 * "Recent" everything they may read. The tab lives in the URL, so a link lands
 * on it. Opening the page reads the feed, so the entries that were new keep
 * their dot for this visit while the sidebar badge clears. Each entry's menu
 * follows or unfollows what it is about; unfollowing drops that source from
 * For me at once and offers Undo, which follows it again.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LuActivity } from 'react-icons/lu';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import { listPulse, markPulseRead, setFollow } from '../../api/pulse';
import { ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
import EmptyState from '../../components/ui/empty-state';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import { useShortcut } from '../../hooks/useShortcuts';
import { useWorkspace } from '../../hooks/useWorkspace';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { pulseCountKey, pulseFollowKey, pulseKey } from '../../lib/queryKeys';
import { dayHeading, localDay } from '../../lib/relativeTime';
import { showErrorToast, showToast } from '../../lib/toast';
import type { PulseItemRead, PulseScope } from '../../types/Api';
import PulseEntry from './PulseEntry';
import PulseEntryMenu, {
  ENTRY_MENU_ATTRIBUTE,
  entrySubject,
} from './PulseEntryMenu';
import { entryHref, subjectName } from './pulseDisplay';

/** How often the first page is read again while the page is open. */
const POLL_MS = 60000;

/** The feeds the page switches between, in the order the switch shows them. */
const SCOPES: { id: PulseScope; label: string }[] = [
  { id: 'for_me', label: 'For me' },
  { id: 'popular', label: 'Popular' },
  { id: 'recent', label: 'Recent' },
];

/** The URL parameter holding the tab; absent means For me. */
const TAB_PARAM = 'tab';

/** Reads the tab from the URL, falling back to For me for anything unknown. */
const readScope = (value: string | null): PulseScope =>
  SCOPES.find((option) => option.id === value)?.id ?? 'for_me';

/** What an empty feed says, per scope. */
const EMPTY_MESSAGES: Record<PulseScope, string> = {
  for_me:
    'No updates yet. Follow a project or initiative to see its updates here.',
  popular: 'No updates from the last two weeks yet.',
  recent: 'No project or initiative updates yet.',
};

/** The key an entry's source is dropped by: its subject kind and id, or empty when it names none. */
const sourceKey = (item: PulseItemRead): string => {
  const target = entrySubject(item);
  return target === null ? '' : `${target.subject}:${target.subjectId}`;
};

/** One day's run of entries, under the heading the feed shows for it. */
interface DayGroup {
  key: string;
  heading: string;
  entries: { item: PulseItemRead; index: number }[];
}

/** Splits a newest-first feed into runs of the same local day, keeping each entry's place in the whole list. */
const groupByDay = (items: PulseItemRead[], now: Date): DayGroup[] => {
  const groups: DayGroup[] = [];
  items.forEach((item, index) => {
    const key = localDay(item.created_at);
    const last = groups.at(-1);
    if (last !== undefined && last.key === key) {
      last.entries.push({ item, index });
      return;
    }
    groups.push({
      key,
      heading: dayHeading(item.created_at, now),
      entries: [{ item, index }],
    });
  });
  return groups;
};

/** Props for PulseFeed: the workspace and the scope it reads. */
interface PulseFeedProps {
  workspaceId: string;
  slug: string;
  scope: PulseScope;
}

/**
 * One scope's feed: the polled first page, older pages on request, and the
 * read marker moved once there is something unread. The page keys it on the
 * workspace and scope, so switching starts it afresh.
 */
const PulseFeed: React.FC<PulseFeedProps> = ({ workspaceId, slug, scope }) => {
  const auth = useQueryAuth();
  const [older, setOlder] = useState<PulseItemRead[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const markedFor = useRef<string | null>(null);
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const feed = useRef<HTMLDivElement>(null);

  const query = usePolledQuery(
    ({ signal }) => listPulse(workspaceId, { scope }, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: pulseKey(workspaceId, scope),
      auth,
    }
  );
  const first = query.data;

  useEffect(() => {
    if (first === null || workspaceId === '') return;
    if (!first.items.some((item) => item.unread)) return;
    const mark = first.items[0]?.event_id ?? '';
    if (markedFor.current === mark) return;
    markedFor.current = mark;
    markPulseRead(workspaceId).then(
      () => {
        invalidateQueries(pulseCountKey(workspaceId));
      },
      () => undefined
    );
  }, [first, workspaceId]);

  const nextCursor =
    cursor === undefined ? (first?.next_cursor ?? null) : cursor;
  const seen = new Set((first?.items ?? []).map((item) => item.event_id));
  const loaded = [
    ...(first?.items ?? []),
    ...older.filter((item) => !seen.has(item.event_id)),
  ];
  const items =
    scope === 'for_me' && dropped.size > 0
      ? loaded.filter((item) => !dropped.has(sourceKey(item)))
      : loaded;

  const changeFollow = (item: PulseItemRead, following: boolean): void => {
    const target = entrySubject(item);
    if (target === null) return;
    const key = sourceKey(item);
    const name = subjectName(item);
    const keep = (): void => {
      setDropped((current) => {
        if (!current.has(key)) return current;
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    };
    if (following) keep();
    else setDropped((current) => new Set(current).add(key));
    setFollow(workspaceId, target.subject, target.subjectId, following).then(
      () => {
        invalidateQueries([
          pulseKey(workspaceId, 'for_me'),
          pulseCountKey(workspaceId),
          pulseFollowKey(workspaceId, target.subject, target.subjectId),
        ]);
        if (following) {
          showToast(`Following ${name} in Pulse`);
          return;
        }
        showToast(`Unfollowed ${name}`, 'info', {
          action: {
            label: 'Undo',
            run: () => {
              changeFollow(item, true);
            },
          },
        });
      },
      (failure: unknown) => {
        if (!following) keep();
        showErrorToast(errorMessage(failure, 'Could not change the follow.'));
      }
    );
  };

  const navigate = useNavigate();
  const activate = useCallback(
    (index: number) => {
      const item = items[index];
      if (item === undefined) return;
      const href = entryHref(slug, item);
      if (href !== '') void navigate(href);
    },
    [items, navigate, slug]
  );
  const { activeIndex, setActiveIndex, registerItem } = useListKeyboardNav({
    count: items.length,
    onActivate: activate,
    resetKey: scope,
    enabled: !menuOpen,
  });

  const openMenu = (event?: KeyboardEvent): void => {
    const trigger = feed.current?.querySelector<HTMLElement>(
      `article[aria-current="true"] [${ENTRY_MENU_ATTRIBUTE}]`
    );
    if (trigger === null || trigger === undefined) return;
    event?.preventDefault();
    trigger.click();
  };
  const menuShortcut = activeIndex !== -1 && !menuOpen;
  useShortcut({
    keys: 'shift+f10',
    label: 'Open entry menu',
    group: 'List',
    enabled: menuShortcut,
    handler: openMenu,
  });
  useShortcut({
    keys: 'contextmenu',
    label: 'Open entry menu',
    group: 'List',
    enabled: menuShortcut,
    handler: openMenu,
  });

  const renderEntry = (item: PulseItemRead, index: number): React.ReactNode => (
    <PulseEntry
      key={item.event_id}
      item={item}
      slug={slug}
      active={activeIndex === index}
      entryRef={registerItem(index)}
      onPointerEnter={() => {
        if (!menuOpen) setActiveIndex(index);
      }}
      menu={
        <PulseEntryMenu
          workspaceId={workspaceId}
          slug={slug}
          item={item}
          onUnfollow={(target) => {
            changeFollow(target, false);
          }}
          onFollow={(target) => {
            changeFollow(target, true);
          }}
          onOpenChange={(open) => {
            setMenuOpen(open);
            if (open) setActiveIndex(index);
          }}
        />
      }
    />
  );

  const loadMore = (): void => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    listPulse(workspaceId, { scope, cursor: nextCursor }).then(
      (page) => {
        setOlder((current) => [...current, ...page.items]);
        setCursor(page.next_cursor);
        setLoadingMore(false);
      },
      (failure: unknown) => {
        setMoreError(failure);
        setLoadingMore(false);
      }
    );
  };

  if (query.error !== null && first === null) {
    return (
      <div className="px-4 pt-3 lg:px-6">
        <ErrorAlert
          message={errorMessage(query.error, 'Could not load your Pulse.')}
        />
      </div>
    );
  }
  if (first === null) return <SkeletonRows label="Loading Pulse" />;
  if (items.length === 0) {
    return <EmptyState icon={<LuActivity />} message={EMPTY_MESSAGES[scope]} />;
  }
  return (
    <div ref={feed} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 pb-10 sm:px-6">
        <section
          aria-label={SCOPES.find((option) => option.id === scope)?.label}
        >
          {scope === 'popular' ? (
            <div className="flex flex-col gap-3 pt-6">
              {items.map((item, index) => renderEntry(item, index))}
            </div>
          ) : (
            groupByDay(items, new Date()).map((group) => (
              <section
                key={group.key}
                aria-labelledby={`pulse-day-${group.key}`}
                className="pb-2"
              >
                <h2
                  id={`pulse-day-${group.key}`}
                  className="sticky top-0 z-10 bg-bg/95 pt-6 pb-3 text-xs font-medium text-text-muted backdrop-blur-sm"
                >
                  {group.heading}
                </h2>
                <div className="flex flex-col gap-3">
                  {group.entries.map(({ item, index }) =>
                    renderEntry(item, index)
                  )}
                </div>
              </section>
            ))
          )}
        </section>
        {moreError !== null && (
          <div className="mt-3">
            <ErrorAlert
              message={errorMessage(moreError, 'Could not load more.')}
            />
          </div>
        )}
        {nextCursor !== null && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore
                ? 'Loading'
                : scope === 'popular'
                  ? 'Show more'
                  : 'Show older'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

/** The Pulse page. */
export const Pulse: React.FC = () => {
  const { workspace } = useWorkspace();
  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';
  const [params, setParams] = useSearchParams();
  const scope = readScope(params.get(TAB_PARAM));
  const setScope = (next: PulseScope): void => {
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next === 'for_me') updated.delete(TAB_PARAM);
      else updated.set(TAB_PARAM, next);
      return updated;
    });
  };

  return (
    <WorkspaceShell
      title="Pulse"
      flush
      actions={
        <div
          role="group"
          aria-label="Show"
          className="flex items-center gap-0.5 rounded-md border border-line p-0.5"
        >
          {SCOPES.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={scope === option.id}
              onClick={() => {
                setScope(option.id);
              }}
              className={cn(
                'rounded-sm px-2 py-0.5 text-xs transition-colors duration-100 pointer-coarse:px-3 pointer-coarse:py-2.5 focus-visible:outline-2 focus-visible:outline-accent',
                scope === option.id
                  ? 'bg-raised text-text'
                  : 'text-text-muted hover:text-text'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      }
    >
      <PulseFeed
        key={`${workspaceId}:${scope}`}
        workspaceId={workspaceId}
        slug={slug}
        scope={scope}
      />
    </WorkspaceShell>
  );
};

export default Pulse;
