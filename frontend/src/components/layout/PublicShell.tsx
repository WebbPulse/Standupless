/**
 * The frame every signed out page renders in: the home page, sign in, sign up
 * and the password and email pages. A slim top bar with the wordmark, the
 * section links and the two account actions, the page itself, and a short
 * footer, all on the near black public palette inside one centred container.
 *
 * The bar's "Log in" link is the signed out marker the browser suite waits for
 * after a sign out, so it only renders while nobody is signed in. A signed in
 * visitor who lands on one of these pages sees a link back into the app in its
 * place.
 */

import React from 'react';
import { LuArrowRight } from 'react-icons/lu';
import { Link, NavLink } from 'react-router-dom';
import { Wordmark } from '../../brand';
import { useAuth } from '../../hooks/useAuth';
import { cn } from '../../lib/cn';
import { PRIVACY_PATH, TERMS_PATH, WORKSPACES_PATH } from '../../lib/paths';
import {
  PILL_PRIMARY,
  PUBLIC_CONTAINER,
  PUBLIC_SECTIONS,
} from './publicStyles';

const NAV_LINK =
  'rounded-xs text-[13px] text-text-muted transition-colors hover:text-text';

/** The top bar: wordmark, section links, a hairline divider and the account actions. */
export const PublicNav: React.FC = () => {
  const { isAuthenticated } = useAuth();

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className={cn(PUBLIC_CONTAINER, 'flex h-16 items-center gap-8')}>
        <Link
          to="/"
          className="shrink-0 rounded-xs"
          aria-label="Standupless home"
        >
          <Wordmark size={20} />
        </Link>
        <nav aria-label="Product" className="hidden items-center gap-6 md:flex">
          {PUBLIC_SECTIONS.map((section) => (
            <Link
              key={section.id}
              to={{ pathname: '/', hash: `#${section.id}` }}
              className={NAV_LINK}
            >
              {section.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-4">
          <span
            aria-hidden="true"
            className="hidden h-4 w-px bg-line-strong md:block"
          />
          {isAuthenticated ? (
            <Link
              to={WORKSPACES_PATH}
              className={cn(PILL_PRIMARY, 'h-8 px-3.5 text-[13px]')}
            >
              Open app
              <LuArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          ) : (
            <>
              <NavLink
                to="/login"
                className={NAV_LINK}
                data-testid="signed-out"
              >
                Log in
              </NavLink>
              <NavLink
                to="/register"
                className={cn(PILL_PRIMARY, 'h-8 px-3.5 text-[13px]')}
              >
                Sign up
              </NavLink>
            </>
          )}
        </div>
      </div>
    </header>
  );
};

/** The year the footer's notice carries, read once when the bundle loads. */
const YEAR = new Date().getFullYear();

const FOOTER_LINK =
  'rounded-xs text-text-muted transition-colors hover:text-text';

/** The footer: the wordmark, the section, account and legal links, and the notice. */
export const PublicFooter: React.FC = () => (
  <footer className="border-t border-line">
    <div
      className={cn(
        PUBLIC_CONTAINER,
        'grid gap-10 py-14 text-[13px] sm:grid-cols-[1fr_auto_auto_auto] sm:gap-16'
      )}
    >
      <div className="space-y-4">
        <Wordmark size={18} />
        <p className="text-text-faint">© {String(YEAR)} Standupless</p>
      </div>
      <nav aria-label="Product links" className="space-y-3">
        <p className="font-medium text-text">Product</p>
        <ul className="space-y-2.5">
          {PUBLIC_SECTIONS.map((section) => (
            <li key={section.id}>
              <Link
                to={{ pathname: '/', hash: `#${section.id}` }}
                className={FOOTER_LINK}
              >
                {section.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <nav aria-label="Account links" className="space-y-3">
        <p className="font-medium text-text">Account</p>
        <ul className="space-y-2.5">
          <li>
            <Link to="/login" className={FOOTER_LINK}>
              Log in
            </Link>
          </li>
          <li>
            <Link to="/register" className={FOOTER_LINK}>
              Sign up
            </Link>
          </li>
          <li>
            <Link to="/forgot-password" className={FOOTER_LINK}>
              Reset password
            </Link>
          </li>
        </ul>
      </nav>
      <nav aria-label="Legal links" className="space-y-3">
        <p className="font-medium text-text">Legal</p>
        <ul className="space-y-2.5">
          <li>
            <Link to={PRIVACY_PATH} className={FOOTER_LINK}>
              Privacy
            </Link>
          </li>
          <li>
            <Link to={TERMS_PATH} className={FOOTER_LINK}>
              Terms
            </Link>
          </li>
        </ul>
      </nav>
    </div>
  </footer>
);

/** Props for PublicShell: the page and an optional class for its main area. */
export interface PublicShellProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * The bar, the page and the footer on the public palette. The page is the
 * `main` landmark, so a page passes its sections rather than its own `main`.
 */
export const PublicShell: React.FC<PublicShellProps> = ({
  children,
  className = '',
}) => (
  <div className="public-site flex min-h-screen flex-col bg-bg text-text">
    <PublicNav />
    <main className={cn('flex-1', className)}>{children}</main>
    <PublicFooter />
  </div>
);

export default PublicShell;
