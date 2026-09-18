/**
 * The centred card that frames an auth page's title and body.
 */

import React from 'react';

/** Props for AuthCard: the heading and the page body. */
export interface AuthCardProps {
  title: string;
  children: React.ReactNode;
}

/** A centred card with a heading. */
const AuthCard: React.FC<AuthCardProps> = ({ title, children }) => (
  <div className="flex min-h-screen items-center justify-center px-4 py-12">
    <div className="w-full max-w-md space-y-6 rounded-xl bg-slate-950 p-8 shadow-lg">
      <h1 className="text-center text-2xl font-semibold text-white">{title}</h1>
      {children}
    </div>
  </div>
);

export default AuthCard;
