/**
 * The frame for the signed out pages: the wordmark, a title and the page body
 * in a narrow centred column. It carries the signed out marker the browser
 * suite looks for after a sign out.
 */

import React from 'react';
import Wordmark from '../layout/Wordmark';

/** Props for AuthCard: the heading and the page body. */
export interface AuthCardProps {
  title: string;
  children: React.ReactNode;
}

/** A centred column with the wordmark and a heading. */
const AuthCard: React.FC<AuthCardProps> = ({ title, children }) => (
  <div
    className="flex min-h-screen flex-col items-center bg-surface px-4 pt-[14vh] pb-12"
    data-testid="signed-out"
  >
    <Wordmark className="mb-8" />
    <main className="w-full max-w-sm space-y-5 rounded-lg border border-line bg-bg p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <h1 className="text-lg font-semibold">{title}</h1>
      {children}
    </main>
  </div>
);

export default AuthCard;
