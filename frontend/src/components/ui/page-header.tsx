/**
 * The slim 40px bar at the top of every page: the title on the left, the actions on
 * the right, and an optional second row for filters. The same bar carries the
 * phone menu button, so it is the one place the page and the shell meet.
 *
 * Pages put their filter chips in a {@link FilterRow} inside the toolbar. On a
 * desktop the row dissolves into the toolbar and wraps with it; below the `sm`
 * breakpoint it takes the toolbar's full width and scrolls sideways in one
 * line, so a long set of filters never pushes the page wider than the phone.
 */

import React from 'react';
import { cn } from '../../lib/cn';
import { useTruncationTooltip } from './truncated-text';

/** Props for PageHeader: the title, the actions and an optional toolbar row. */
export interface PageHeaderProps {
  title: React.ReactNode;
  /** Buttons on the right of the title. */
  actions?: React.ReactNode;
  /** A second row under the title, for filters and view switches. */
  toolbar?: React.ReactNode;
  /** A control right after the title, such as the favorite star, kept out of the heading's name. */
  titleAccessory?: React.ReactNode;
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
  titleAccessory,
  level = 1,
  className = '',
}) => {
  const Heading = level === 1 ? 'h1' : 'h2';
  const titleTip = useTruncationTooltip<HTMLHeadingElement>();
  return (
    <header className={cn('border-b border-line', className)}>
      <div className="flex h-topbar items-center gap-3 px-4 lg:px-6">
        {leading}
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <Heading
            ref={titleTip.ref}
            className={cn(
              'min-w-0 truncate text-sm font-medium',
              titleAccessory === undefined && 'flex-1'
            )}
            {...titleTip.handlers}
          >
            {title}
          </Heading>
          {titleAccessory}
        </div>
        {titleTip.tip}
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

/** Props for FilterRow: the filter controls and any extra classes. */
export interface FilterRowProps {
  children: React.ReactNode;
  className?: string;
}

/** The classes that keep a filter row in one sideways scrolling line on a phone. */
export const FILTER_ROW_CLASS =
  'flex items-center gap-1.5 max-sm:w-full max-sm:overflow-x-auto max-sm:overscroll-x-contain max-sm:[scrollbar-width:none] max-sm:*:shrink-0 sm:contents';

/** A page header's filter chips, in one sideways scrolling line on a phone. */
export const FilterRow: React.FC<FilterRowProps> = ({
  children,
  className,
}) => (
  <div data-filter-row="" className={cn(FILTER_ROW_CLASS, className)}>
    {children}
  </div>
);

export default PageHeader;
