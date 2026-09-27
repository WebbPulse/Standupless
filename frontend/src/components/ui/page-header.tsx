/**
 * The 44px bar at the top of every page: the title on the left, the actions on
 * the right, and an optional second row for filters. The same bar carries the
 * phone menu button, so it is the one place the page and the shell meet.
 */

import React from 'react';
import { cn } from '../../lib/cn';

/** Props for PageHeader: the title, the actions and an optional toolbar row. */
export interface PageHeaderProps {
  title: React.ReactNode;
  /** Buttons on the right of the title. */
  actions?: React.ReactNode;
  /** A second row under the title, for filters and view switches. */
  toolbar?: React.ReactNode;
  /** Something before the title, such as a breadcrumb or a glyph. */
  leading?: React.ReactNode;
  /** The heading level. Pages use 1; sections inside a page use 2. */
  level?: 1 | 2;
  className?: string;
}

/** A page's top bar. */
export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  actions,
  toolbar,
  leading,
  level = 1,
  className = '',
}) => {
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <header className={cn('border-b border-line', className)}>
      <div className="flex h-topbar items-center gap-3 px-4 lg:px-6">
        {leading}
        <Heading className="min-w-0 flex-1 truncate text-base font-semibold">
          {title}
        </Heading>
        {actions !== undefined && (
          <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
        )}
      </div>
      {toolbar !== undefined && (
        <div className="flex min-h-10 flex-wrap items-center gap-2 border-t border-line px-4 py-1.5 lg:px-6">
          {toolbar}
        </div>
      )}
    </header>
  );
};

export default PageHeader;
