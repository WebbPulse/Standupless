/**
 * Moves a tab onto the current build at its next navigation. A tab left open
 * across a deploy keeps running the old bundle, whose chunks the deploy
 * pruned and which lacks every fix shipped since, so clicking into a page can
 * fail on code that no longer exists. Checking in the background and loading
 * the new address as a full page, rather than rendering it with stale code,
 * means a long-lived tab or desktop window picks up each release on its own.
 */

import React, { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import {
  BUILD_CHECK_INTERVAL_MS,
  BUILD_CHECK_MIN_GAP_MS,
  isNewerBuildLive,
  runningBuildId,
} from '../../lib/buildFreshness';
import { reloadOnceForChunkError } from '../../lib/chunkReload';

/** Props for BuildFreshness: seams for tests. */
export interface BuildFreshnessProps {
  /** The entry script this tab booted from, or null to do nothing. */
  running?: string | null;
  /** Whether a newer build than `running` is live. */
  check?: (running: string) => Promise<boolean>;
  /** Loads the current address afresh. Defaults to a guarded reload. */
  reload?: () => void;
}

/** Watches for a newer build and reloads into it on the next route change. */
export const BuildFreshness: React.FC<BuildFreshnessProps> = ({
  running = runningBuildId(),
  check = isNewerBuildLive,
  reload = () => {
    reloadOnceForChunkError();
  },
}) => {
  const { pathname } = useLocation();
  const stale = useRef(false);
  const lastCheck = useRef(0);
  const firstPath = useRef(pathname);

  useEffect(() => {
    if (running === null) return undefined;
    let active = true;
    const probe = (): void => {
      const now = Date.now();
      if (stale.current || now - lastCheck.current < BUILD_CHECK_MIN_GAP_MS) {
        return;
      }
      lastCheck.current = now;
      void check(running).then((newer) => {
        if (active && newer) stale.current = true;
      });
    };
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') probe();
    };
    const timer = setInterval(probe, BUILD_CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', probe);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', probe);
    };
  }, [running, check]);

  useEffect(() => {
    if (pathname === firstPath.current) return;
    firstPath.current = pathname;
    if (stale.current) reload();
  }, [pathname, reload]);

  return null;
};

export default BuildFreshness;
