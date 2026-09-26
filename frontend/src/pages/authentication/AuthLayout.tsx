/**
 * The frame the sign in, sign up, password and email pages render in. It sits
 * inside the same public shell as the home page, so the top bar and footer
 * carry across, and sets the form in a narrow column under a large heading
 * instead of a boxed card.
 */

import React from 'react';
import { Logo } from '../../brand';
import PublicShell from '../../components/layout/PublicShell';

/** Props for AuthLayout: the heading and the page body. */
export interface AuthLayoutProps {
  title: string;
  /** A sentence under the heading, when the page needs one. */
  subtitle?: string;
  children: React.ReactNode;
}

/** A centred column with the mark, the heading and the form under it. */
export const AuthLayout: React.FC<AuthLayoutProps> = ({
  title,
  subtitle,
  children,
}) => (
  <PublicShell className="flex justify-center px-4 pt-[12vh] pb-24">
    <div className="w-full max-w-sm space-y-7">
      <div className="space-y-3">
        <Logo size={32} title={null} className="text-accent" />
        <h1 className="text-[28px] leading-[1.15] font-semibold tracking-[-0.03em] text-text">
          {title}
        </h1>
        {subtitle !== undefined && (
          <p className="text-sm text-text-muted">{subtitle}</p>
        )}
      </div>
      <div className="space-y-5">{children}</div>
    </div>
  </PublicShell>
);

export default AuthLayout;
