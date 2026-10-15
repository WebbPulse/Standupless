/**
 * The public download page at `/download`: the desktop installer for the
 * visitor's platform first, every other build beside it, the app store
 * listings once they exist, and plain steps for opening a build that is not
 * signed yet. Every link points at a fixed name on the `desktop-latest`
 * release, so a new version never breaks one.
 */

import React, { useEffect, useSyncExternalStore } from 'react';
import {
  LuDownload,
  LuExternalLink,
  LuLaptop,
  LuMonitor,
  LuPackage,
  LuShieldAlert,
  LuTerminal,
} from 'react-icons/lu';
import PublicShell from '../../components/layout/PublicShell';
import {
  PILL_PRIMARY,
  PILL_SECONDARY,
  PUBLIC_CONTAINER,
} from '../../components/layout/publicStyles';
import { cn } from '../../lib/cn';
import {
  currentDesktopPlatform,
  DESKTOP_BUILDS,
  DESKTOP_RELEASE_URL,
  MOBILE_STORE_URLS,
  type DesktopBuild,
  type DesktopPlatform,
} from '../../lib/desktop';

/** The document title while this page is showing. */
export const DOWNLOAD_TITLE = 'Download | Standupless';

/** The description crawlers and link previews show for this page. */
export const DOWNLOAD_DESCRIPTION =
  'Download the Standupless desktop app for macOS, Windows and Linux.';

const ICON = 'h-4 w-4';

/** The icon each build's row carries. */
const buildIcon = (build: DesktopBuild): React.ReactNode => {
  if (build.platform === 'mac') return <LuLaptop className={ICON} />;
  if (build.platform === 'windows') return <LuMonitor className={ICON} />;
  return build.fileName.endsWith('.deb') ? (
    <LuPackage className={ICON} />
  ) : (
    <LuTerminal className={ICON} />
  );
};

/** Sets the page title and description while the page is mounted. */
const useDownloadMeta = (): void => {
  useEffect(() => {
    const previousTitle = document.title;
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]'
    );
    const previousDescription = meta?.content;
    document.title = DOWNLOAD_TITLE;
    if (meta !== null) meta.content = DOWNLOAD_DESCRIPTION;
    return () => {
      document.title = previousTitle;
      if (meta !== null && previousDescription !== undefined) {
        meta.content = previousDescription;
      }
    };
  }, []);
};

/** The platform never changes while the page is open, so nothing to watch. */
const subscribeToNothing = (): (() => void) => () => undefined;

/** The prerendered answer: no platform, so every build shows in order. */
const noPlatform = (): DesktopPlatform | null => null;

/**
 * The visitor's desktop platform. The server snapshot is none, so the
 * prerendered page and its hydration agree before the browser's answer lands.
 */
const useVisitorPlatform = (): DesktopPlatform | null =>
  useSyncExternalStore(subscribeToNothing, currentDesktopPlatform, noPlatform);

/** One step list for opening an unsigned build on one operating system. */
interface FirstLaunch {
  platform: DesktopPlatform;
  title: string;
  steps: { id: string; text: React.ReactNode }[];
}

const CODE =
  'rounded-xs bg-raised px-1 py-px font-mono text-[12px] text-text break-all';

const FIRST_LAUNCH: FirstLaunch[] = [
  {
    platform: 'mac',
    title: 'macOS',
    steps: [
      {
        id: 'mac-1',
        text: 'Open the disk image and drag Standupless into Applications.',
      },
      {
        id: 'mac-2',
        text: 'Open Standupless. macOS says it cannot check the app, so choose Done.',
      },
      {
        id: 'mac-3',
        text: 'In System Settings, open Privacy & Security, scroll to Security and choose Open Anyway, then confirm.',
      },
      {
        id: 'mac-4',
        text: (
          <>
            If macOS says the app is damaged, run{' '}
            <code className={CODE}>
              xattr -dr com.apple.quarantine /Applications/Standupless.app
            </code>{' '}
            in Terminal and open it again.
          </>
        ),
      },
    ],
  },
  {
    platform: 'windows',
    title: 'Windows',
    steps: [
      {
        id: 'windows-1',
        text: 'Run the installer. SmartScreen says it protected your PC.',
      },
      { id: 'windows-2', text: 'Choose More info, then Run anyway.' },
    ],
  },
  {
    platform: 'linux',
    title: 'Linux',
    steps: [
      {
        id: 'linux-1',
        text: (
          <>
            For the AppImage, run{' '}
            <code className={CODE}>chmod +x Standupless.AppImage</code> and open
            it.
          </>
        ),
      },
      {
        id: 'linux-2',
        text: (
          <>
            For the package, run{' '}
            <code className={CODE}>
              sudo apt install ./standupless-desktop_amd64.deb
            </code>
            .
          </>
        ),
      },
    ],
  },
];

/** The store badges, or nothing while neither listing exists. */
const StoreBadges: React.FC = () => {
  const stores = [
    { label: 'Download on the App Store', href: MOBILE_STORE_URLS.appStore },
    { label: 'Get it on Google Play', href: MOBILE_STORE_URLS.googlePlay },
  ].filter(
    (store): store is { label: string; href: string } => store.href !== null
  );
  if (stores.length === 0) return null;
  return (
    <section aria-labelledby="download-mobile-title" className="space-y-4">
      <h2
        id="download-mobile-title"
        className="text-[15px] font-medium text-text"
      >
        Mobile
      </h2>
      <div className="flex flex-wrap gap-2">
        {stores.map((store) => (
          <a
            key={store.label}
            href={store.href}
            target="_blank"
            rel="noreferrer"
            className={cn(PILL_SECONDARY, 'h-9 px-4 text-sm')}
          >
            {store.label}
          </a>
        ))}
      </div>
    </section>
  );
};

/** The download page. */
const Download: React.FC = () => {
  useDownloadMeta();
  const platform = useVisitorPlatform();
  const primary = DESKTOP_BUILDS.find((build) => build.platform === platform);
  const builds =
    primary === undefined
      ? DESKTOP_BUILDS
      : [primary, ...DESKTOP_BUILDS.filter((build) => build !== primary)];
  const steps =
    platform === null
      ? FIRST_LAUNCH
      : [
          ...FIRST_LAUNCH.filter((entry) => entry.platform === platform),
          ...FIRST_LAUNCH.filter((entry) => entry.platform !== platform),
        ];

  return (
    <PublicShell>
      <section
        aria-labelledby="download-title"
        className={cn(
          PUBLIC_CONTAINER,
          'space-y-14 pt-20 pb-24 sm:pt-28 sm:pb-32'
        )}
      >
        <div className="space-y-5">
          <h1
            id="download-title"
            className="text-[40px] leading-[1.05] font-semibold tracking-[-0.045em] text-text sm:text-[56px]"
          >
            Download Standupless
          </h1>
          <p className="max-w-xl text-[17px] leading-relaxed text-text-muted">
            The desktop app for macOS, Windows and Linux, with a dock or taskbar
            badge for your unread inbox, native notifications and{' '}
            <code className="font-mono text-[15px] text-text">
              standupless://
            </code>{' '}
            links. It tells you when a new version ships.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {primary === undefined ? null : (
              <a
                href={primary.href}
                data-testid="download-primary"
                className={cn(PILL_PRIMARY, 'h-9 px-4 text-sm')}
              >
                <LuDownload aria-hidden="true" className={ICON} />
                Download for {primary.label}
              </a>
            )}
            <a
              href={DESKTOP_RELEASE_URL}
              target="_blank"
              rel="noreferrer"
              className={cn(PILL_SECONDARY, 'h-9 px-4 text-sm')}
            >
              Release notes
              <LuExternalLink
                aria-hidden="true"
                className="h-3.5 w-3.5 text-text-faint"
              />
            </a>
          </div>
        </div>

        <section aria-labelledby="download-builds-title" className="space-y-4">
          <h2
            id="download-builds-title"
            className="text-[15px] font-medium text-text"
          >
            Desktop
          </h2>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {builds.map((build) => (
              <li
                key={build.fileName}
                className="flex flex-col gap-3 bg-bg px-5 py-4 sm:flex-row sm:items-center sm:gap-4"
              >
                <span className="flex min-w-0 flex-1 items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-text-muted"
                  >
                    {buildIcon(build)}
                  </span>
                  <span className="min-w-0 space-y-0.5">
                    <span className="flex items-center gap-2 text-sm font-medium text-text">
                      {build.label}
                      {build === primary ? (
                        <span className="rounded-full bg-accent-soft px-1.5 py-px text-[11px] font-medium text-accent">
                          Your platform
                        </span>
                      ) : null}
                    </span>
                    <span className="block truncate text-[13px] text-text-muted">
                      {build.detail}
                      <span className="text-text-faint">
                        {' '}
                        &middot; {build.fileName}
                      </span>
                    </span>
                  </span>
                </span>
                <a
                  href={build.href}
                  data-testid={`download-${build.fileName}`}
                  className="inline-flex h-7 shrink-0 items-center gap-1.5 self-start rounded-sm border border-line-strong bg-bg px-2 text-xs font-medium text-text transition-colors duration-100 hover:bg-raised sm:self-auto"
                >
                  <LuDownload aria-hidden="true" className="h-3 w-3" />
                  Download
                </a>
              </li>
            ))}
          </ul>
        </section>

        <StoreBadges />

        <section
          aria-labelledby="download-unsigned-title"
          className="space-y-6 rounded-xl border border-line bg-surface p-6 sm:p-7"
        >
          <div className="flex items-start gap-3">
            <LuShieldAlert
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 shrink-0 text-text-muted"
            />
            <div className="space-y-1">
              <h2
                id="download-unsigned-title"
                className="text-[15px] font-medium text-text"
              >
                These builds are not signed yet
              </h2>
              <p className="text-sm leading-relaxed text-text-muted">
                Until code signing ships, macOS and Windows warn the first time
                you open Standupless. The steps below get past that warning.
              </p>
            </div>
          </div>
          <div className="grid gap-6 md:grid-cols-3">
            {steps.map((entry) => (
              <div key={entry.platform} className="space-y-2">
                <h3 className="text-sm font-medium text-text">{entry.title}</h3>
                <ol className="list-decimal space-y-1.5 pl-4 text-sm leading-relaxed text-text-muted marker:text-text-faint">
                  {entry.steps.map((step) => (
                    <li key={step.id}>{step.text}</li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </section>
      </section>
    </PublicShell>
  );
};

export default Download;
