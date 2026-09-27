/**
 * An inline text link in the accent colour, for sentences that point somewhere.
 */

import React from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { cn } from '../../lib/cn';

/** The classes an inline link carries. */
export const LINK_CLASS =
  'rounded-xs text-accent underline-offset-2 hover:underline';

/** A router link styled as inline text. */
export const TextLink: React.FC<LinkProps> = ({ className = '', ...props }) => (
  <Link className={cn(LINK_CLASS, className)} {...props} />
);

export default TextLink;
