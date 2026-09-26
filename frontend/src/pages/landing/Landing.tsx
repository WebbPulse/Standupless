/**
 * The public home page at `/`. A signed out visitor sees what Standupless is
 * and how to start; a signed in one is sent on to their workspaces, which in
 * turn forwards into their only workspace when they have one.
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
import { Link, Navigate } from 'react-router-dom';
import { Logo, Wordmark } from '../../brand';
import { Kbd } from '../../components/ui/badge';
import { StatusGlyph } from '../../components/ui/glyphs';
import Spinner from '../../components/ui/spinner';
import { useAuth } from '../../hooks/useAuth';
import { cn } from '../../lib/cn';
import { WORKSPACES_PATH } from '../../lib/paths';
import AppPreview from './AppPreview';

/** The document title while this page is showing. */
export const LANDING_TITLE = 'Standupless: issue tracking for software teams';

/** The meta description while this page is showing. */
export const LANDING_DESCRIPTION =
  'Standupless is an issue tracker for software teams. Plan cycles, track projects on a roadmap, move fast from the keyboard and link pull requests to issues.';

const CTA_BASE =
  'inline-flex h-9 items-center justify-center gap-2 rounded-sm px-4 text-sm font-medium whitespace-nowrap transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
const CTA_PRIMARY = cn(
  CTA_BASE,
  'bg-accent text-on-accent hover:bg-accent-strong'
);
const CTA_SECONDARY = cn(
  CTA_BASE,
  'border border-line-strong bg-surface text-text hover:bg-raised'
);

/** The year the footer's notice carries, read once when the page loads. */
const YEAR = new Date().getFullYear();

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
    body: 'Switch between a list and a board, filter by anything, and save the views you come back to so the whole team can use them.',
  },
  {
    icon: <LuInbox className={FEATURE_ICON} />,
    title: 'Inbox and notifications',
    body: 'Assignments, mentions, comments and status changes land in one inbox, and reach your verified email address too.',
  },
];

/** One keyboard shortcut shown in the speed section. */
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

/** A section's small heading, its title and its lead sentence. */
const SectionHeading: React.FC<{
  eyebrow: string;
  title: string;
  lead: string;
  id: string;
  className?: string;
}> = ({ eyebrow, title, lead, id, className = '' }) => (
  <div className={cn('max-w-2xl space-y-3', className)}>
    <p className="text-xs font-medium text-accent">{eyebrow}</p>
    <h2
      id={id}
      className="text-2xl font-semibold tracking-tight text-text sm:text-[32px] sm:leading-[1.15]"
    >
      {title}
    </h2>
    <p className="text-base leading-relaxed text-text-muted">{lead}</p>
  </div>
);

/** A still of the command palette for the keyboard section. */
const PalettePreview: React.FC = () => (
  <div
    aria-hidden="true"
    className="overflow-hidden rounded-lg border border-line-strong bg-overlay shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)] select-none"
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
    className="space-y-3 rounded-lg border border-line-strong bg-surface p-4 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)] select-none sm:p-5"
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

/** The marketing page itself, with no session logic. */
export const LandingContent: React.FC = () => {
  useLandingMeta();

  return (
    <div className="min-h-screen bg-bg text-text" data-testid="landing">
      <header className="sticky top-0 z-20 border-b border-line/60 bg-bg/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link to="/" className="rounded-xs" aria-label="Standupless home">
            <Wordmark size={20} />
          </Link>
          <nav
            aria-label="Sections"
            className="hidden items-center gap-5 text-[13px] text-text-muted md:flex"
          >
            <a href="#features" className="hover:text-text">
              Features
            </a>
            <a href="#keyboard" className="hover:text-text">
              Keyboard
            </a>
            <a href="#github" className="hover:text-text">
              GitHub
            </a>
            <a href="#api" className="hover:text-text">
              API
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Link
              to="/login"
              className="rounded-sm px-3 py-1.5 text-[13px] text-text-muted transition-colors hover:text-text"
            >
              Log in
            </Link>
            <Link
              to="/register"
              className={cn(CTA_PRIMARY, 'h-8 px-3 text-[13px]')}
            >
              Sign up
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section
          aria-labelledby="hero-title"
          className="relative overflow-hidden"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-[640px] bg-[radial-gradient(60%_50%_at_50%_0%,var(--accent-soft),transparent_70%)] opacity-70"
          />
          <div className="relative mx-auto max-w-6xl px-4 pt-16 pb-12 text-center sm:px-6 sm:pt-24 sm:pb-16">
            <p className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-line bg-surface/80 px-3 py-1 text-xs text-text-muted">
              <Logo size={14} title={null} />
              Issue tracking for software teams
            </p>
            <h1
              id="hero-title"
              className="mx-auto max-w-3xl bg-gradient-to-b from-text to-text-muted bg-clip-text text-4xl font-semibold tracking-[-0.03em] text-transparent sm:text-6xl sm:leading-[1.05]"
            >
              Plan and track the work, without the standup
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-text-muted sm:text-lg">
              Standupless keeps your team's issues, cycles and projects in one
              fast, keyboard first tracker, so everyone can see what changed
              without a meeting.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                to="/register"
                className={cn(CTA_PRIMARY, 'w-full sm:w-auto')}
              >
                Get started
                <LuArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              <Link
                to="/login"
                className={cn(CTA_SECONDARY, 'w-full sm:w-auto')}
              >
                Log in
              </Link>
            </div>
          </div>
          <div className="relative mx-auto max-w-6xl px-4 pb-20 sm:px-6 sm:pb-28">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-10 -top-6 h-40 rounded-full bg-accent/10 blur-3xl"
            />
            <AppPreview />
          </div>
        </section>

        <section
          id="features"
          aria-labelledby="features-title"
          className="scroll-mt-16 border-t border-line"
        >
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
            <SectionHeading
              id="features-title"
              eyebrow="Features"
              title="Everything the team is working on, in one place"
              lead="Standupless covers the whole loop of planning, doing and shipping, from the first issue to the project it rolls up into."
            />
            <ul className="mt-12 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature) => (
                <li key={feature.title} className="space-y-2 bg-bg p-6">
                  <span
                    aria-hidden="true"
                    className="flex h-8 w-8 items-center justify-center rounded-sm border border-line bg-surface text-text-muted"
                  >
                    {feature.icon}
                  </span>
                  <h3 className="pt-2 text-[15px] font-medium text-text">
                    {feature.title}
                  </h3>
                  <p className="text-sm leading-relaxed text-text-muted">
                    {feature.body}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section
          id="keyboard"
          aria-labelledby="keyboard-title"
          className="scroll-mt-16 border-t border-line bg-surface/40"
        >
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 sm:px-6 sm:py-28 lg:grid-cols-2">
            <div className="space-y-8">
              <SectionHeading
                id="keyboard-title"
                eyebrow="Speed"
                title="Built for the keyboard"
                lead="Pages load fast and every common action has a shortcut. Press Command K or Ctrl K to reach any action from anywhere."
              />
              <ul className="divide-y divide-line rounded-md border border-line bg-bg">
                {SHORTCUTS.map((shortcut) => (
                  <li
                    key={shortcut.label}
                    className="flex h-10 items-center justify-between gap-3 px-4 text-sm"
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

        <section
          id="github"
          aria-labelledby="github-title"
          className="scroll-mt-16 border-t border-line"
        >
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 sm:px-6 sm:py-28 lg:grid-cols-2">
            <div className="order-2 lg:order-1">
              <PullRequestPreview />
            </div>
            <div className="order-1 space-y-6 lg:order-2">
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

        <section
          id="api"
          aria-labelledby="api-title"
          className="scroll-mt-16 border-t border-line bg-surface/40"
        >
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
            <SectionHeading
              id="api-title"
              eyebrow="API"
              title="Open to the rest of your tools"
              lead="Everything in the app is available to your scripts, your services and your AI assistants."
            />
            <ul className="mt-12 grid gap-4 sm:grid-cols-3">
              {[
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
              ].map((item) => (
                <li
                  key={item.title}
                  className="space-y-2 rounded-lg border border-line bg-bg p-5"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-8 w-8 items-center justify-center rounded-sm border border-line bg-surface text-text-muted"
                  >
                    {item.icon}
                  </span>
                  <h3 className="pt-2 text-[15px] font-medium text-text">
                    {item.title}
                  </h3>
                  <p className="text-sm leading-relaxed text-text-muted">
                    {item.body}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section
          aria-labelledby="start-title"
          className="relative overflow-hidden border-t border-line"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-72 bg-[radial-gradient(50%_60%_at_50%_100%,var(--accent-soft),transparent_70%)] opacity-60"
          />
          <div className="relative mx-auto flex max-w-6xl flex-col items-center gap-6 px-4 py-24 text-center sm:px-6">
            <Logo size={40} title={null} />
            <h2
              id="start-title"
              className="text-2xl font-semibold tracking-tight sm:text-4xl"
            >
              Set up your workspace in a minute
            </h2>
            <p className="max-w-md text-base text-text-muted">
              Create a workspace, add a team and file your first issue.
            </p>
            <div className="flex w-full flex-col items-center justify-center gap-3 sm:w-auto sm:flex-row">
              <Link
                to="/register"
                className={cn(CTA_PRIMARY, 'w-full sm:w-auto')}
              >
                Get started
              </Link>
              <Link
                to="/login"
                className={cn(CTA_SECONDARY, 'w-full sm:w-auto')}
              >
                Log in
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-xs text-text-faint sm:flex-row sm:items-center sm:px-6">
          <Wordmark size={16} />
          <nav
            aria-label="Footer"
            className="flex flex-wrap gap-x-5 gap-y-2 sm:ml-6"
          >
            <a href="#features" className="hover:text-text">
              Features
            </a>
            <a href="#github" className="hover:text-text">
              GitHub integration
            </a>
            <a href="#api" className="hover:text-text">
              API
            </a>
            <Link to="/login" className="hover:text-text">
              Log in
            </Link>
            <Link to="/register" className="hover:text-text">
              Sign up
            </Link>
          </nav>
          <p className="sm:ml-auto">© {String(YEAR)} Standupless</p>
        </div>
      </footer>
    </div>
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
