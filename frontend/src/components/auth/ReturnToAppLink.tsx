/**
 * The way back to the app from a sign-up, password or email page in the browser.
 * It reads the kept request after hydration, so a prerendered page and the first
 * client render agree, and it hides on the handoff page, which is where it leads,
 * and inside the apps, which have nothing to return to.
 */

import React, { useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { DESKTOP_HANDOFF_PATH } from '../../lib/paths';
import { pendingAppHandoffPath } from '../../lib/pendingAppHandoff';
import { isAppShell } from '../../lib/shell';
import TextLink from '../ui/link';

/** The kept request changes only through this page's own navigation. */
const subscribeToNothing = (): (() => void) => () => undefined;

/** Answers no kept request while prerendering and hydrating. */
const noPendingPath = (): null => null;

/** Reads the kept request with the current time, as a stable string. */
const readPendingPath = (): string | null => pendingAppHandoffPath();

/** A link back to the handoff page, or nothing without a kept request. */
const ReturnToAppLink: React.FC = () => {
  const { pathname } = useLocation();
  const path = useSyncExternalStore(
    subscribeToNothing,
    readPendingPath,
    noPendingPath
  );
  if (path === null || pathname === DESKTOP_HANDOFF_PATH || isAppShell()) {
    return null;
  }
  return (
    <p className="text-sm text-text-muted">
      <TextLink to={path} data-testid="return-to-app">
        Return to the Standupless app
      </TextLink>
    </p>
  );
};

export default ReturnToAppLink;
