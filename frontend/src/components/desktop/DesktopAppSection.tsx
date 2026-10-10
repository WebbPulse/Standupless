/**
 * The settings section that offers the desktop app, hidden when the page is
 * already running inside it.
 */

import React from 'react';
import { LuExternalLink } from 'react-icons/lu';
import { DESKTOP_DOWNLOAD_URL, isDesktopShell } from '../../lib/desktop';

/** The "Desktop app" section, or nothing inside the desktop app. */
const DesktopAppSection: React.FC = () => {
  if (isDesktopShell()) return null;
  return (
    <section
      id="desktop"
      aria-labelledby="desktop-title"
      className="scroll-mt-4 space-y-4"
    >
      <div className="space-y-1">
        <h2 id="desktop-title" className="text-base font-semibold">
          Desktop app
        </h2>
        <p className="text-sm text-text-muted">
          Standupless for macOS, Windows and Linux, with a dock or taskbar badge
          for your unread inbox, native notifications and{' '}
          <code className="rounded-xs bg-raised px-1 py-px font-mono text-xs text-text">
            standupless://
          </code>{' '}
          links.
        </p>
      </div>
      <a
        href={DESKTOP_DOWNLOAD_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-line-strong bg-bg px-2 text-xs font-medium text-text transition-colors duration-100 hover:bg-raised"
      >
        Download the desktop app
        <LuExternalLink
          aria-hidden="true"
          className="h-3 w-3 text-text-faint"
        />
      </a>
    </section>
  );
};

export default DesktopAppSection;
