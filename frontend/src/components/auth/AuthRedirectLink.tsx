/**
 * The footer line on an auth page pointing at another auth route.
 */

import React from 'react';
import TextLink from '../ui/link';

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
  <p className="text-sm text-text-muted">
    {text} <TextLink to={to}>{linkText}</TextLink>
  </p>
);

export default AuthRedirectLink;
