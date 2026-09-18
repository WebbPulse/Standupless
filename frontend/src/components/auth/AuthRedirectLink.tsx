/**
 * The footer line on an auth page pointing at another auth route.
 */

import React from 'react';
import { Link } from 'react-router-dom';

/** Props for AuthRedirectLink: the lead-in text, the link text and its target. */
export interface AuthRedirectLinkProps {
  text: string;
  linkText: string;
  to: string;
}

/** A sentence ending in a link to another auth route. */
const AuthRedirectLink: React.FC<AuthRedirectLinkProps> = ({
  text,
  linkText,
  to,
}) => (
  <p className="text-center text-sm text-slate-400">
    {text}{' '}
    <Link to={to} className="font-medium text-sky-400 hover:text-sky-300">
      {linkText}
    </Link>
  </p>
);

export default AuthRedirectLink;
