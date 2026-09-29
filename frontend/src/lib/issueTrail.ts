/**
 * The list an issue was opened from, remembered for the browser tab so the
 * issue page can step through that list with j and k and return to it with
 * Escape, the way a triage pass works through a view one issue at a time.
 *
 * The trail lives in session storage, which is per tab and survives a reload,
 * with an in-memory copy for when storage is unavailable.
 */

/** The ordered issue keys of one list and the path that shows it. */
export interface IssueTrail {
  slug: string;
  keys: string[];
  from: string;
}

/** Where an issue sits in the trail it was opened from. */
export interface TrailPosition {
  /** The issue's zero-based place in the trail. */
  index: number;
  total: number;
  previous: string | null;
  next: string | null;
  from: string;
}

/** The session storage key holding the trail. */
export const ISSUE_TRAIL_STORAGE_KEY = 'standupless.issueTrail';

let held: IssueTrail | null = null;

/** Whether a parsed value has the shape of a trail. */
const isTrail = (value: unknown): value is IssueTrail => {
  if (typeof value !== 'object' || value === null) return false;
  const trail = value as Partial<Record<keyof IssueTrail, unknown>>;
  return (
    typeof trail.slug === 'string' &&
    typeof trail.from === 'string' &&
    Array.isArray(trail.keys) &&
    trail.keys.every((key) => typeof key === 'string')
  );
};

/** Remembers the list an issue is being opened from. */
export const rememberTrail = (trail: IssueTrail): void => {
  held = trail;
  try {
    globalThis.sessionStorage.setItem(
      ISSUE_TRAIL_STORAGE_KEY,
      JSON.stringify(trail)
    );
  } catch {
    return;
  }
};

/** The remembered trail, or null when no list opened an issue in this tab. */
export const readTrail = (): IssueTrail | null => {
  try {
    const raw = globalThis.sessionStorage.getItem(ISSUE_TRAIL_STORAGE_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (isTrail(parsed)) return parsed;
    }
  } catch {
    return held;
  }
  return held;
};

/** Forgets the trail, for tests and sign-out. */
export const clearTrail = (): void => {
  held = null;
  try {
    globalThis.sessionStorage.removeItem(ISSUE_TRAIL_STORAGE_KEY);
  } catch {
    return;
  }
};

/**
 * Where an issue sits in a trail, or null when the trail belongs to another
 * workspace or does not hold the issue. Keys match without regard to case, so
 * a key typed in lower case into the address bar still finds its place.
 */
export const trailPosition = (
  trail: IssueTrail | null,
  slug: string,
  key: string
): TrailPosition | null => {
  if (trail === null || trail.slug !== slug) return null;
  const wanted = key.toUpperCase();
  const index = trail.keys.findIndex((each) => each.toUpperCase() === wanted);
  if (index === -1) return null;
  return {
    index,
    total: trail.keys.length,
    previous: trail.keys[index - 1] ?? null,
    next: trail.keys[index + 1] ?? null,
    from: trail.from,
  };
};
