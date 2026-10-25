/**
 * A date chip in rendered Markdown: the day in the viewer's locale, as Today,
 * Tomorrow or Yesterday when it is that close, with the full date on hover.
 * The rich editor draws the same chip from the same labels.
 */

import React from 'react';
import { LuCalendar } from 'react-icons/lu';
import { dateChipLabel, dateChipTitle, dateToken } from '../../lib/dateChips';

/** Props for DateChip: the ISO day it shows. */
export interface DateChipProps {
  value: string;
}

/** One date chip. */
export const DateChip: React.FC<DateChipProps> = ({ value }) => (
  <time
    dateTime={value}
    title={dateChipTitle(value)}
    data-md={dateToken(value)}
    className="inline-flex items-baseline gap-1 rounded-xs bg-raised px-1 font-medium text-text"
  >
    <LuCalendar
      aria-hidden="true"
      className="h-3 w-3 shrink-0 self-center text-text-muted"
    />
    {dateChipLabel(value)}
  </time>
);

export default DateChip;
