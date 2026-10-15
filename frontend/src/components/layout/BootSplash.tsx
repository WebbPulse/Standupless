/**
 * The cold start screen: the Standupless mark over a small spinner, centred in
 * the viewport on the theme's page colour. index.html paints the same markup
 * as `#boot-splash` before the bundle loads, and its inline stylesheet styles
 * both, so the session check, the workspace lookup and the static shell read
 * as one screen with no jump or flash between them.
 */

import React, { useLayoutEffect, useState } from 'react';
import Logo from '../../brand/Logo';
import {
  BOOT_SPLASH_MARK_SIZE,
  STATIC_BOOT_SPLASH_ID,
  bootSplashPhase,
} from '../../lib/bootSplash';

/** Props for BootSplash: what assistive technology announces. */
export interface BootSplashProps {
  label?: string;
}

/**
 * Covers the viewport with the cold start screen while the app is still
 * finding out who is signed in or which workspace a link names.
 */
const BootSplash: React.FC<BootSplashProps> = ({ label = 'Loading' }) => {
  const [phase] = useState(() => bootSplashPhase());
  return (
    <div
      className="boot-splash"
      role="status"
      aria-live="polite"
      aria-label={label}
      data-testid="boot-splash"
      style={{ '--boot-phase': phase } as React.CSSProperties}
    >
      <Logo
        size={BOOT_SPLASH_MARK_SIZE}
        title={null}
        className="boot-splash-mark"
      />
      <span className="boot-splash-spinner" />
    </div>
  );
};

/**
 * Removes the static splash in the same commit as the app's first render,
 * before the browser paints it, so the static and rendered screens never
 * show together and the page is never left blank between them.
 */
export const BootSplashHandoff: React.FC = () => {
  useLayoutEffect(() => {
    document.getElementById(STATIC_BOOT_SPLASH_ID)?.remove();
  }, []);
  return null;
};

export default BootSplash;
