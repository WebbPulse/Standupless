/**
 * The cycle page's title as a switcher. The title opens a filterable list of
 * the team's cycles, the current one first, then upcoming soonest first, then
 * previous ones most recent first, each marked with where it sits. Arrows
 * beside it step to the cycle before or after in date order and stand
 * disabled at either end. The command palette offers the same steps, plus a
 * jump to the running cycle under Linear's `G` then `V`, while the page is open.
 *
 * Stepping skips cancelled cycles, since nothing happens in them, unless the
 * cycle in view is one; the list still offers them under their own heading.
 */

import React, { useCallback, useMemo } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { LuChevronDown, LuChevronLeft, LuChevronRight } from 'react-icons/lu';
import { useNavigate } from 'react-router-dom';
import { listCycles } from '../../api/planning';
import { useShortcut } from '../../hooks/useShortcuts';
import { cycleTitle } from '../../lib/cycleBreakdown';
import { cyclePath, teamCurrentCyclePath } from '../../lib/paths';
import { cyclesKey } from '../../lib/queryKeys';
import { shortDateLabel } from '../../lib/propertyOptions';
import type { CycleListRead, CycleRead } from '../../types/Api';
import { IconButton } from '../ui/button';
import Combobox, { type ComboboxOption } from '../ui/combobox';
import { Popover } from '../ui/popover';

/** How often the switcher re-reads the team's cycles. */
const POLL_MS = 60000;

/** How many cycles one page of the read asks for, the endpoint's ceiling. */
const PAGE_SIZE = 100;

/** The heading a cycle lists under, by where it sits against today. */
const GROUP_LABELS: Record<CycleRead['status'], string> = {
  active: 'Current',
  upcoming: 'Upcoming',
  completed: 'Previous',
  cancelled: 'Cancelled',
};

/** The order the list's headings come in. */
const GROUP_RANK: Record<CycleRead['status'], number> = {
  active: 0,
  upcoming: 1,
  completed: 2,
  cancelled: 3,
};

/** Whether `left` starts before `right`, the cycle id breaking a tie. */
const byStart = (left: CycleRead, right: CycleRead): number =>
  left.start_date.localeCompare(right.start_date) ||
  left.cycle_id.localeCompare(right.cycle_id);

/**
 * The cycles the arrows step through, oldest first: the team's own cycles
 * that are not cancelled, with the cycle in view kept whatever its state.
 */
export const steppingOrder = (
  cycles: readonly CycleRead[],
  teamId: string,
  currentId: string
): CycleRead[] =>
  cycles
    .filter(
      (cycle) =>
        cycle.team_id === teamId &&
        (cycle.status !== 'cancelled' || cycle.cycle_id === currentId)
    )
    .sort(byStart);

/** The cycles either side of the one in view, or null at an end. */
export const neighbourCycles = (
  order: readonly CycleRead[],
  currentId: string
): { previous: CycleRead | null; next: CycleRead | null } => {
  const at = order.findIndex((cycle) => cycle.cycle_id === currentId);
  if (at === -1) return { previous: null, next: null };
  return {
    previous: at > 0 ? (order[at - 1] ?? null) : null,
    next: order[at + 1] ?? null,
  };
};

/**
 * The team's own cycles in list order: current, upcoming soonest first, then
 * previous and cancelled ones most recent first.
 */
export const switcherCycles = (
  cycles: readonly CycleRead[],
  teamId: string
): CycleRead[] =>
  cycles
    .filter((cycle) => cycle.team_id === teamId)
    .sort((left, right) => {
      const rank = GROUP_RANK[left.status] - GROUP_RANK[right.status];
      if (rank !== 0) return rank;
      return left.status === 'active' || left.status === 'upcoming'
        ? byStart(left, right)
        : byStart(right, left);
    });

/** Reads every page of a team's own cycles. */
const readTeamCycles = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<CycleRead[]> => {
  const rows: CycleRead[] = [];
  let cursor: string | null = null;
  do {
    const page: CycleListRead = await listCycles(
      workspaceId,
      {
        team_id: teamId,
        limit: PAGE_SIZE,
        ...(cursor === null ? {} : { cursor }),
      },
      signal
    );
    rows.push(...page.cycles);
    if (page.next_cursor !== null && page.next_cursor === cursor) break;
    cursor = page.next_cursor;
  } while (cursor !== null);
  return rows;
};

/** Props for CycleSwitcher: the cycle in view and the team it belongs to. */
export interface CycleSwitcherProps {
  workspaceId: string;
  slug: string;
  teamId: string;
  keyPrefix: string;
  cycle: CycleRead;
}

/** The cycle title's dropdown and the previous and next arrows beside it. */
export const CycleSwitcher: React.FC<CycleSwitcherProps> = ({
  workspaceId,
  slug,
  teamId,
  keyPrefix,
  cycle,
}) => {
  const auth = useQueryAuth();
  const navigate = useNavigate();
  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      readTeamCycles(workspaceId, teamId, signal),
    [workspaceId, teamId]
  );
  const { data } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: workspaceId !== '' && teamId !== '',
    queryKey: cyclesKey(workspaceId, teamId, 'switcher'),
    auth,
  });

  const rows = useMemo(() => {
    const held = data ?? [];
    return held.some((row) => row.cycle_id === cycle.cycle_id)
      ? held.map((row) => (row.cycle_id === cycle.cycle_id ? cycle : row))
      : [...held, cycle];
  }, [data, cycle]);
  const order = useMemo(
    () => steppingOrder(rows, teamId, cycle.cycle_id),
    [rows, teamId, cycle.cycle_id]
  );
  const { previous, next } = neighbourCycles(order, cycle.cycle_id);
  const running = rows.find(
    (row) => row.team_id === teamId && row.status === 'active'
  );

  const options = useMemo<ComboboxOption[]>(
    () =>
      switcherCycles(rows, teamId).map((row) => ({
        value: row.cycle_id,
        label: cycleTitle(row),
        detail: `${shortDateLabel(row.start_date)} to ${shortDateLabel(row.end_date)}`,
        group: GROUP_LABELS[row.status],
      })),
    [rows, teamId]
  );

  const open = useCallback(
    (target: CycleRead | null | undefined): void => {
      if (target === null || target === undefined) return;
      if (target.cycle_id === cycle.cycle_id) return;
      void navigate(cyclePath(slug, keyPrefix, target.cycle_id));
    },
    [navigate, slug, keyPrefix, cycle.cycle_id]
  );

  useShortcut({
    keys: '',
    label: 'Go to previous cycle',
    scope: 'page',
    group: 'Cycle',
    enabled: previous !== null,
    handler: () => {
      open(previous);
    },
  });
  useShortcut({
    keys: '',
    label: 'Go to next cycle',
    scope: 'page',
    group: 'Cycle',
    enabled: next !== null,
    handler: () => {
      open(next);
    },
  });
  useShortcut({
    keys: 'g v',
    label: 'Go to current cycle',
    scope: 'page',
    group: 'Cycle',
    enabled: cycle.status !== 'active',
    handler: (event) => {
      event?.preventDefault();
      if (running === undefined) {
        void navigate(teamCurrentCyclePath(slug, keyPrefix));
        return;
      }
      open(running);
    },
  });

  const title = cycleTitle(cycle);
  return (
    <span className="flex min-w-0 items-center gap-0.5">
      <Popover
        label="Switch cycle"
        contentClassName="w-72"
        className="min-w-0"
        trigger={(trigger) => (
          <button
            type="button"
            {...trigger}
            aria-label={`${title}, switch cycle`}
            data-testid="cycle-switcher"
            className="flex min-w-0 items-center gap-1 rounded-xs px-1 hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            <span className="truncate">{title}</span>
            <LuChevronDown
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-text-faint"
            />
          </button>
        )}
      >
        {(close) => (
          <Combobox
            label="Cycles"
            placeholder="Switch to cycle"
            options={options}
            selected={[cycle.cycle_id]}
            emptyMessage="No cycles match"
            onSelect={(picked) => {
              close();
              open(rows.find((row) => row.cycle_id === picked));
            }}
          />
        )}
      </Popover>
      <IconButton
        label="Previous cycle"
        size="sm"
        disabled={previous === null}
        onClick={() => {
          open(previous);
        }}
      >
        <LuChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton
        label="Next cycle"
        size="sm"
        disabled={next === null}
        onClick={() => {
          open(next);
        }}
      >
        <LuChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
      </IconButton>
    </span>
  );
};

export default CycleSwitcher;
