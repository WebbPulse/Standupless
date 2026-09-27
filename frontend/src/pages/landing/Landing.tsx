/**
 * The public home page at `/`. A signed out visitor sees what Standupless is
 * and how to start; a signed in one is sent on to their workspaces, which in
 * turn forwards into their only workspace when they have one.
 *
 * The page sits in the shared public shell, so its top bar and footer are the
 * ones the sign in and sign up pages carry too. The bar links to the sections
 * here by hash, and the page scrolls to the named section whenever the hash
 * changes, since a client side navigation does not scroll on its own.
 *
 * The guard follows the guest route convention: a spinner while the session is
 * still being read, and no redirect while a sign in or sign out is in flight,
 * so the page does not flash between the two states.
 *
 * Every claim here names something the product ships today.
 */

import React, { useEffect } from 'react';
import {
  LuArrowRight,
  LuBell,
  LuCalendarRange,
  LuCode,
  LuColumns3,
  LuGitMerge,
  LuGitPullRequest,
  LuInbox,
  LuLayers,
  LuListTodo,
  LuMap,
  LuSearch,
  LuUsers,
  LuWebhook,
} from 'react-icons/lu';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { Kbd } from '../../components/ui/badge';
import { StatusGlyph } from '../../components/ui/glyphs';
import Spinner from '../../components/ui/spinner';
import PublicShell from '../../components/layout/PublicShell';
import {
  PILL_PRIMARY,
  PILL_SECONDARY,
  PUBLIC_CONTAINER,
} from '../../components/layout/publicStyles';
import { useAuth } from '../../hooks/useAuth';
import { cn } from '../../lib/cn';
import { WORKSPACES_PATH } from '../../lib/paths';
import AppPreview from './AppPreview';

/** The document title while this page is showing. */
export const LANDING_TITLE = 'Standupless: issue tracking for software teams';

/** The meta description while this page is showing. */
export const LANDING_DESCRIPTION =
  'Standupless is an issue tracker for software teams. Plan cycles, track projects on a roadmap, work from the keyboard and link pull requests to issues.';

/** One feature on the home page. */
interface Feature {
  icon: React.ReactNode;
  title: string;
  body: string;
}

const FEATURE_ICON = 'h-4 w-4';

const FEATURES: Feature[] = [
  {
    icon: <LuListTodo className={FEATURE_ICON} />,
    title: 'Issues',
    body: 'Every issue gets a team key, a status, a priority, labels, an estimate and an assignee. Break big work into sub-issues and link related ones.',
  },
  {
    icon: <LuUsers className={FEATURE_ICON} />,
    title: 'Teams',
    body: 'Each team keeps its own key prefix, workflow statuses, labels and members, so one workspace can hold several ways of working.',
  },
  {
    icon: <LuCalendarRange className={FEATURE_ICON} />,
    title: 'Cycles',
    body: 'Plan work in time boxed cycles and watch progress roll up from the issues inside them as they move.',
  },
  {
    icon: <LuMap className={FEATURE_ICON} />,
    title: 'Projects and roadmap',
    body: 'Group issues across teams into projects with a lead, dates and progress, then see every project and cycle on one roadmap.',
  },
  {
    icon: <LuColumns3 className={FEATURE_ICON} />,
    title: 'Board, list and saved views',
    body: 'Switch between a list and a board, filter by any property, and save the views you come back to so the whole team can use them.',
  },
  {
    icon: <LuInbox className={FEATURE_ICON} />,
    title: 'Inbox and notifications',
    body: 'Assignments, mentions, comments and status changes land in one inbox, and reach your verified email address too.',
  },
];

/** One way into the product from outside the app, for the API section. */
const INTEGRATIONS: Feature[] = [
  {
    icon: <LuCode className={FEATURE_ICON} />,
    title: 'REST API',
    body: 'A documented API with workspace API keys for scripts and services.',
  },
  {
    icon: <LuWebhook className={FEATURE_ICON} />,
    title: 'Webhooks',
    body: 'Get a signed request when an issue is created, updated or changes status, or when someone comments.',
  },
  {
    icon: <LuBell className={FEATURE_ICON} />,
    title: 'MCP server',
    body: 'Let AI assistants that speak the Model Context Protocol read and update issues on your behalf.',
  },
];

/** One keyboard shortcut shown in the keyboard section. */
interface Shortcut {
  keys: string[];
  label: string;
}

const SHORTCUTS: Shortcut[] = [
  { keys: ['C'], label: 'Create an issue' },
  { keys: ['⌘', 'K'], label: 'Open the command palette' },
  { keys: ['/'], label: 'Search' },
  { keys: ['G', 'I'], label: 'Go to your inbox' },
  { keys: ['G', 'M'], label: 'Go to my issues' },
  { keys: ['J', 'K'], label: 'Move through a list' },
  { keys: ['?'], label: 'See every shortcut' },
];

const SHADOW = 'shadow-[0_32px_80px_-24px_rgba(0,0,0,0.7)]';

/**
 * A section's label, title and lead. `split` sets the lead beside the title on
 * wide screens, for the sections that run the full container width.
 */
const SectionHeading: React.FC<{
  eyebrow: string;
  title: string;
  lead: string;
  id: string;
  split?: boolean;
}> = ({ eyebrow, title, lead, id, split = false }) => (
  <div
    className={cn(
      'gap-x-16 gap-y-5',
      split ? 'grid lg:grid-cols-2 lg:items-end' : 'flex flex-col'
    )}
  >
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-[13px] text-text-muted">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full bg-accent"
        />
        {eyebrow}
      </p>
      <h2
        id={id}
        className="max-w-xl text-[32px] leading-[1.08] font-semibold tracking-[-0.035em] text-text sm:text-[44px]"
      >
        {title}
      </h2>
    </div>
    <p
      className={cn(
        'max-w-md text-[15px] leading-relaxed text-text-muted',
        split && 'lg:justify-self-end'
      )}
    >
      {lead}
    </p>
  </div>
);

/** A still of the command palette for the keyboard section. */
const PalettePreview: React.FC = () => (
  <div
    aria-hidden="true"
    className={cn(
      'overflow-hidden rounded-xl border border-line-strong bg-overlay select-none',
      SHADOW
    )}
  >
    <div className="flex h-11 items-center gap-2 border-b border-line px-4 text-sm">
      <LuSearch className="h-4 w-4 text-text-faint" />
      <span className="text-text">go to</span>
      <span className="h-4 w-px animate-pulse bg-accent" />
    </div>
    <div className="space-y-px p-1.5 text-[13px]">
      <p className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium text-text-faint">
        Navigation
      </p>
      {[
        { label: 'Inbox', keys: ['G', 'I'], active: true },
        { label: 'My issues', keys: ['G', 'M'] },
        { label: 'Projects', keys: ['G', 'P'] },
        { label: 'Roadmap', keys: ['G', 'R'] },
        { label: 'Views', keys: ['G', 'V'] },
      ].map((row) => (
        <div
          key={row.label}
          className={cn(
            'flex h-8 items-center gap-2 rounded-sm px-2.5',
            row.active === true ? 'bg-raised text-text' : 'text-text-muted'
          )}
        >
          <span className="flex-1">{row.label}</span>
          {row.keys.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
        </div>
      ))}
    </div>
  </div>
);

/** A still of a linked pull request for the GitHub section. */
const PullRequestPreview: React.FC = () => (
  <div
    aria-hidden="true"
    className={cn(
      'space-y-3 rounded-xl border border-line-strong bg-surface p-4 select-none sm:p-5',
      SHADOW
    )}
  >
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#8e7cf0]/20 text-[#a594ff]">
        <LuGitMerge className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-text">
          Add a token bucket to search
        </p>
        <p className="font-mono text-xs text-text-faint">
          acme/web #482 · maya/eng-214-rate-limit
        </p>
        <p className="text-xs text-text-muted">
          <span className="rounded-xs bg-raised px-1 font-mono text-text">
            Fixes ENG-214
          </span>
        </p>
      </div>
    </div>
    <div className="space-y-2 border-t border-line pt-3 text-xs">
      <div className="flex items-center gap-2 text-text-muted">
        <LuGitPullRequest className="h-3.5 w-3.5 text-text-faint" />
        Pull request opened
        <LuArrowRight className="h-3 w-3 text-text-faint" />
        <StatusGlyph category="started" />
        <span className="text-text">In Progress</span>
      </div>
      <div className="flex items-center gap-2 text-text-muted">
        <LuGitMerge className="h-3.5 w-3.5 text-text-faint" />
        Pull request merged
        <LuArrowRight className="h-3 w-3 text-text-faint" />
        <StatusGlyph category="completed" />
        <span className="text-text">Done</span>
      </div>
    </div>
  </div>
);

/** A grid of features split by hairlines, three across on wide screens. */
const FeatureGrid: React.FC<{ items: Feature[] }> = ({ items }) => (
  <ul className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
    {items.map((feature) => (
      <li key={feature.title} className="space-y-2 bg-bg p-6 sm:p-7">
        <span aria-hidden="true" className="flex text-text-muted">
          {feature.icon}
        </span>
        <h3 className="pt-3 text-[15px] font-medium text-text">
          {feature.title}
        </h3>
        <p className="text-sm leading-relaxed text-text-muted">
          {feature.body}
        </p>
      </li>
    ))}
  </ul>
);

/** Sets the page title and description while the page is mounted. */
const useLandingMeta = (): void => {
  useEffect(() => {
    const previousTitle = document.title;
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]'
    );
    const previousDescription = meta?.content;
    document.title = LANDING_TITLE;
    if (meta !== null) meta.content = LANDING_DESCRIPTION;
    return () => {
      document.title = previousTitle;
      if (meta !== null && previousDescription !== undefined) {
        meta.content = previousDescription;
      }
    };
  }, []);
};

/** Scrolls to the section the location's hash names, each time it changes. */
const useHashScroll = (): void => {
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === '') return;
    const target = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (typeof target?.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start' });
    }
  }, [hash]);
};

const SECTION = 'scroll-mt-16 border-t border-line';
const SECTION_BODY = cn(PUBLIC_CONTAINER, 'py-24 sm:py-32');

/** The marketing page itself, with no session logic. */
export const LandingContent: React.FC = () => {
  useLandingMeta();
  useHashScroll();

  return (
    <PublicShell>
      <div data-testid="landing">
        <section
          id="product"
          aria-labelledby="hero-title"
          className="relative scroll-mt-16 overflow-hidden"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-[720px] bg-[radial-gradient(45%_55%_at_20%_0%,var(--accent-soft),transparent_70%)] opacity-50"
          />
          <div
            className={cn(
              PUBLIC_CONTAINER,
              'relative pt-20 pb-14 sm:pt-28 sm:pb-20 lg:pt-36'
            )}
          >
            <h1
              id="hero-title"
              className="max-w-[15ch] text-[44px] leading-[1.02] font-semibold tracking-[-0.045em] text-text sm:text-[64px] lg:text-[80px]"
            >
              Issues, cycles and projects for software teams
            </h1>
            <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-text-muted sm:text-lg">
              Standupless is an issue tracker for software engineers. File
              issues, plan cycles, group work into projects and link pull
              requests, then check progress in the app instead of in a meeting.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                to="/register"
                className={cn(PILL_PRIMARY, 'h-10 px-5 text-sm')}
              >
                Get started
              </Link>
              <Link
                to="/login"
                className={cn(PILL_SECONDARY, 'h-10 px-5 text-sm')}
              >
                Log in
                <LuArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
          </div>
          <div className={cn(PUBLIC_CONTAINER, 'relative pb-20 sm:pb-28')}>
            <div className="[mask-image:linear-gradient(to_bottom,black_75%,transparent)]">
              <AppPreview />
            </div>
          </div>
        </section>

        <section
          id="features"
          aria-labelledby="features-title"
          className={SECTION}
        >
          <div className={cn(SECTION_BODY, 'space-y-14')}>
            <SectionHeading
              id="features-title"
              eyebrow="Features"
              title="What a workspace holds"
              lead="Issues, the teams that own them, the cycles and projects they are planned into, and the views and inbox you read them through."
              split
            />
            <FeatureGrid items={FEATURES} />
          </div>
        </section>

        <section
          id="keyboard"
          aria-labelledby="keyboard-title"
          className={SECTION}
        >
          <div
            className={cn(
              SECTION_BODY,
              'grid items-center gap-14 lg:grid-cols-2 lg:gap-20'
            )}
          >
            <div className="space-y-10">
              <SectionHeading
                id="keyboard-title"
                eyebrow="Keyboard"
                title="Every common action has a shortcut"
                lead="Press Command K or Ctrl K to reach any action from anywhere, or learn the single keys for the ones you use most."
              />
              <ul className="divide-y divide-line rounded-xl border border-line">
                {SHORTCUTS.map((shortcut) => (
                  <li
                    key={shortcut.label}
                    className="flex h-11 items-center justify-between gap-3 px-4 text-sm"
                  >
                    <span className="text-text-muted">{shortcut.label}</span>
                    <span className="flex items-center gap-1">
                      {shortcut.keys.map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <PalettePreview />
          </div>
        </section>

        <section id="github" aria-labelledby="github-title" className={SECTION}>
          <div
            className={cn(
              SECTION_BODY,
              'grid items-center gap-14 lg:grid-cols-2 lg:gap-20'
            )}
          >
            <div className="order-2 lg:order-1">
              <PullRequestPreview />
            </div>
            <div className="order-1 space-y-8 lg:order-2">
              <SectionHeading
                id="github-title"
                eyebrow="GitHub"
                title="Pull requests move issues for you"
                lead="Connect the GitHub app and mention an issue key in a branch name, pull request title or description. The pull request is linked to the issue automatically."
              />
              <ul className="space-y-3 text-sm text-text-muted">
                <li className="flex gap-3">
                  <LuGitPullRequest
                    className="mt-0.5 h-4 w-4 shrink-0 text-accent"
                    aria-hidden="true"
                  />
                  Opening a pull request moves the issue to In Progress.
                </li>
                <li className="flex gap-3">
                  <LuGitMerge
                    className="mt-0.5 h-4 w-4 shrink-0 text-accent"
                    aria-hidden="true"
                  />
                  Merging one that says Fixes, Closes or Resolves before the key
                  moves the issue to Done.
                </li>
                <li className="flex gap-3">
                  <LuLayers
                    className="mt-0.5 h-4 w-4 shrink-0 text-accent"
                    aria-hidden="true"
                  />
                  Each team chooses which status every step moves to.
                </li>
              </ul>
            </div>
          </div>
        </section>

        <section id="api" aria-labelledby="api-title" className={SECTION}>
          <div className={cn(SECTION_BODY, 'space-y-14')}>
            <SectionHeading
              id="api-title"
              eyebrow="API"
              title="Reach the same data from your own tools"
              lead="What you can do in the app, your scripts, services and AI assistants can do through the API."
              split
            />
            <FeatureGrid items={INTEGRATIONS} />
          </div>
        </section>

        <section aria-labelledby="start-title" className="border-t border-line">
          <div
            className={cn(
              PUBLIC_CONTAINER,
              'flex flex-col gap-8 py-24 sm:py-32 lg:flex-row lg:items-end lg:justify-between'
            )}
          >
            <div className="space-y-4">
              <h2
                id="start-title"
                className="max-w-[18ch] text-[32px] leading-[1.08] font-semibold tracking-[-0.035em] text-text sm:text-[44px]"
              >
                Set up a workspace and file your first issue
              </h2>
              <p className="max-w-md text-[15px] text-text-muted">
                Create an account, name the workspace, add a team and start.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                to="/register"
                className={cn(PILL_PRIMARY, 'h-10 px-5 text-sm')}
              >
                Get started
              </Link>
              <Link
                to="/login"
                className={cn(PILL_SECONDARY, 'h-10 px-5 text-sm')}
              >
                Log in
              </Link>
            </div>
          </div>
        </section>
      </div>
    </PublicShell>
  );
};

/** Shows the home page to a visitor and forwards a signed in person on. */
const Landing: React.FC = () => {
  const { isAuthenticated, isLoading, isBusy } = useAuth();

  if (isLoading) return <Spinner label="Checking your session" />;
  if (isAuthenticated && !isBusy) {
    return <Navigate to={WORKSPACES_PATH} replace />;
  }
  return <LandingContent />;
};

export default Landing;
