/**
 * The frame for the signed in pages that sit outside a workspace: the list of
 * workspaces and the account security page. A 44px bar carries the wordmark,
 * the theme toggle and sign out; the page body is a centred column beneath it.
 */

import React from 'react';
import { LuLogOut } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { cn } from '../../lib/cn';
import Avatar from '../ui/avatar';
import Button from '../ui/button';
import ThemeToggle from '../ui/theme-toggle';
import { Wordmark } from '../../brand';

/** Props for AccountShell: the page body and its column width. */
export interface AccountShellProps {
  children: React.ReactNode;
  /** The column width. Narrow suits a single form. */
  width?: 'narrow' | 'wide';
}

/** The top bar and the centred column under it. */
export const AccountShell: React.FC<AccountShellProps> = ({
  children,
  width = 'wide',
}) => {
  const { user, logout } = useAuth();
  return (
    <div className="flex min-h-screen flex-col" data-testid="signed-in">
      <header className="flex h-topbar items-center gap-3 border-b border-line px-4 lg:px-6">
        <Link to="/workspaces" className="rounded-xs">
          <Wordmark size={18} />
        </Link>
        <div className="flex-1" />
        {user !== null && (
          <span className="hidden items-center gap-2 text-xs text-text-muted sm:inline-flex">
            <Avatar name={user.display_name ?? user.email} size="sm" />
            {user.email}
          </span>
        )}
        <ThemeToggle />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void logout()}
          data-testid="sign-out"
        >
          <LuLogOut className="h-3.5 w-3.5" aria-hidden="true" />
          Sign out
        </Button>
      </header>
      <main
        className={cn(
          'mx-auto w-full flex-1 px-4 py-8 lg:px-6',
          width === 'narrow' ? 'max-w-md' : 'max-w-3xl'
        )}
      >
        {children}
      </main>
    </div>
  );
};

export default AccountShell;
