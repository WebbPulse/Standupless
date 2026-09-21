/**
 * The frame the signed out pages render in: the wordmark over a centred card.
 * It replaces the shared AuthCard on these routes so the brand pass stays
 * inside the authentication pages, and it keeps the signed out marker the
 * browser suite looks for after a sign out.
 */

import React from 'react';
import { Wordmark } from '../../brand';

/** Props for AuthLayout: the heading and the page body. */
export interface AuthLayoutProps {
  title: string;
  /** A sentence under the heading, when the page needs one. */
  subtitle?: string;
  children: React.ReactNode;
}

/** A centred card with the wordmark above it. */
export const AuthLayout: React.FC<AuthLayoutProps> = ({
  title,
  subtitle,
  children,
}) => (
  <div
    className="flex min-h-screen flex-col items-center bg-surface px-4 pt-[13vh] pb-12"
    data-testid="signed-out"
  >
    <Wordmark className="mb-7" size={24} />
    <main className="w-full max-w-sm space-y-5 rounded-lg border border-line bg-bg p-6 shadow-[0_1px_2px_rgba(0,0,0,0.05)]">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle !== undefined && (
          <p className="text-sm text-text-muted">{subtitle}</p>
        )}
      </div>
      {children}
    </main>
  </div>
);

export default AuthLayout;
