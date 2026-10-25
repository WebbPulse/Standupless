/**
 * The start and target date picker for projects and initiatives. Like
 * Linear's, it sets an exact day or a whole month, quarter, half or year: a
 * tab per resolution, the day tab being the same presets, typed dates and
 * custom field every other date picker offers, and each coarse tab a grid of
 * periods for one year.
 *
 * It writes nothing itself. A pick reports the stored day, already moved to
 * the start or the end of its period, beside its resolution, so the surface
 * sends both in one write.
 */

import React, { useState } from 'react';
import { LuCalendar, LuChevronLeft, LuChevronRight } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import {
  DATE_RESOLUTIONS,
  RESOLUTION_LABELS,
  isCoarse,
  periodChoices,
  planningDateLabel,
  type DateEdge,
} from '../../lib/dateResolution';
import { dateInRange } from '../../lib/propertyOptions';
import type { DateResolution } from '../../types/Api';
import {
  CustomDate,
  PickerButton,
  dayChoices,
  type PickerBaseProps,
} from '../issues/PropertyPickers';
import { Combobox } from '../ui/combobox';
import { Popover } from '../ui/popover';

/** Props for PlanningDatePicker: the date, its resolution and its range. */
export interface PlanningDatePickerProps extends PickerBaseProps {
  /** The field's name, such as "Target date". */
  field: string;
  value: string | null;
  resolution: DateResolution | null | undefined;
  /** Whether the date opens its period, a start, or closes it, a target. */
  edge: DateEdge;
  /** Reports the stored day and its resolution, or null for a cleared date. */
  onChange: (value: string | null, resolution: DateResolution | null) => void;
  /** The earliest stored day allowed, such as the start date for a target. */
  min?: string;
  /** The latest stored day allowed, such as the target date for a start. */
  max?: string;
  /** The trigger's glyph, or null for a bare date in a dense table cell. */
  icon?: React.ReactNode;
  /** What an unset trigger reads, in place of the field's own phrase. */
  emptyLabel?: string;
}

/** The year a coarse tab opens on: the date's own, or this year. */
const openingYear = (value: string | null, today: Date): number =>
  value === null ? today.getFullYear() : Number(value.slice(0, 4));

/** A grid of one year's periods, with the year stepped by the arrows. */
const PeriodGrid: React.FC<{
  resolution: Exclude<DateResolution, 'day'>;
  edge: DateEdge;
  value: string | null;
  current: DateResolution | null | undefined;
  min: string | undefined;
  max: string | undefined;
  year: number;
  onYear: (year: number) => void;
  onPick: (value: string) => void;
}> = ({ resolution, edge, value, current, min, max, year, onYear, onPick }) => {
  const span = resolution === 'year' ? 6 : 1;
  const choices = periodChoices(year, resolution, edge);
  const heading =
    resolution === 'year' ? `${year} to ${year + span - 1}` : String(year);
  return (
    <div className="space-y-2 p-2">
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-label={resolution === 'year' ? 'Earlier years' : 'Previous year'}
          onClick={() => {
            onYear(year - span);
          }}
          className="flex h-6 w-6 items-center justify-center rounded-sm text-text-muted hover:bg-raised"
        >
          <LuChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="text-xs font-medium text-text tabular-nums">
          {heading}
        </span>
        <button
          type="button"
          aria-label={resolution === 'year' ? 'Later years' : 'Next year'}
          onClick={() => {
            onYear(year + span);
          }}
          className="flex h-6 w-6 items-center justify-center rounded-sm text-text-muted hover:bg-raised"
        >
          <LuChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <div
        className={cn(
          'grid gap-1',
          resolution === 'half' ? 'grid-cols-2' : 'grid-cols-3'
        )}
      >
        {choices.map((choice) => {
          const chosen = current === resolution && value === choice.value;
          return (
            <button
              key={choice.value}
              type="button"
              aria-label={choice.name}
              aria-pressed={chosen}
              disabled={!dateInRange(choice.value, min, max)}
              onClick={() => {
                onPick(choice.value);
              }}
              className={cn(
                'h-8 rounded-sm text-xs tabular-nums transition-colors duration-100 disabled:cursor-default disabled:opacity-40',
                chosen
                  ? 'bg-accent text-on-accent'
                  : 'text-text enabled:hover:bg-raised'
              )}
            >
              {choice.label}
            </button>
          );
        })}
      </div>
    </div>
  );
};

/**
 * Picks a planning date at any resolution. The tab opens on the date's own
 * resolution, so a quarter target reopens on the quarter grid.
 */
export const PlanningDatePicker: React.FC<PlanningDatePickerProps> = ({
  field,
  value,
  resolution,
  edge,
  onChange,
  min,
  max,
  icon = <LuCalendar className="h-3.5 w-3.5" />,
  emptyLabel,
  disabled = false,
  variant = 'rail',
  align = 'start',
  className = '',
  renderTrigger,
}) => {
  const [today] = useState(() => new Date());
  const shown: DateResolution =
    value !== null && isCoarse(resolution) ? resolution : 'day';
  const [tab, setTab] = useState<DateResolution>(shown);
  const [year, setYear] = useState(() => openingYear(value, today));
  const { options, leadOption } = dayChoices({
    today,
    value,
    clearable: true,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  });
  const text =
    value === null
      ? (emptyLabel ??
        (variant === 'chip' ? field : `No ${field.toLowerCase()}`))
      : planningDateLabel(value, resolution, today);
  const pickDay = (picked: string): void => {
    if (picked === '') {
      onChange(null, null);
      return;
    }
    if (picked !== value || isCoarse(resolution)) onChange(picked, 'day');
  };
  return (
    <Popover
      label={field}
      align={align}
      block={variant === 'rail'}
      contentClassName="w-64"
      onOpenChange={(open) => {
        if (!open) return;
        setTab(shown);
        setYear(openingYear(value, today));
      }}
      trigger={(trigger) =>
        renderTrigger === undefined ? (
          <PickerButton
            trigger={trigger}
            field={field}
            icon={icon}
            text={text}
            empty={value === null}
            variant={variant}
            disabled={disabled}
            className={className}
          />
        ) : (
          renderTrigger(trigger)
        )
      }
    >
      {(close) => (
        <div>
          <div
            role="tablist"
            aria-label={`${field} precision`}
            className="flex gap-0.5 border-b border-line p-1"
          >
            {DATE_RESOLUTIONS.map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={tab === option}
                onClick={() => {
                  setTab(option);
                }}
                className={cn(
                  'h-6 flex-1 rounded-sm text-xs transition-colors duration-100',
                  tab === option
                    ? 'bg-raised text-text'
                    : 'text-text-muted hover:text-text'
                )}
              >
                {RESOLUTION_LABELS[option]}
              </button>
            ))}
          </div>
          {isCoarse(tab) ? (
            <PeriodGrid
              resolution={tab}
              edge={edge}
              value={value}
              current={resolution}
              min={min}
              max={max}
              year={year}
              onYear={setYear}
              onPick={(picked) => {
                close();
                if (picked !== value || resolution !== tab)
                  onChange(picked, tab);
              }}
            />
          ) : (
            <Combobox
              label={field}
              placeholder="Try fri, in 3 days or nov 12"
              options={options}
              selected={[value ?? '']}
              onSelect={(picked) => {
                close();
                pickDay(picked);
              }}
              leadOption={leadOption}
              footer={
                <CustomDate
                  value={value}
                  {...(min === undefined || min === '' ? {} : { min })}
                  {...(max === undefined || max === '' ? {} : { max })}
                  onPick={(picked) => {
                    close();
                    pickDay(picked);
                  }}
                />
              }
            />
          )}
        </div>
      )}
    </Popover>
  );
};

export default PlanningDatePicker;
