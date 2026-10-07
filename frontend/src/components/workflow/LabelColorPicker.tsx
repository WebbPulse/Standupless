/**
 * The color picker a label row opens: the palette statuses draw from, as a
 * radio group of swatches, and a hex field for any other `#rrggbb` color the
 * contract accepts. A swatch saves at once; the hex field saves on Enter.
 */

import React, { useId, useState } from 'react';
import { cn } from '../../lib/cn';
import {
  STATUS_COLORS,
  STATUS_COLOR_LABELS,
  STATUS_COLOR_VALUES,
} from '../../lib/statusAppearance';
import Field from '../ui/field';
import { Popover } from '../ui/popover';

/** A `#rrggbb` color, the only form a label color may take. */
const HEX = /^#[0-9a-f]{6}$/i;

/** Props for LabelColorPicker. */
export interface LabelColorPickerProps {
  /** The label's name, announced on the trigger. */
  name: string;
  value: string;
  onChange: (color: string) => void;
  disabled?: boolean;
}

/** A swatch trigger and the palette panel it opens. */
export const LabelColorPicker: React.FC<LabelColorPickerProps> = ({
  name,
  value,
  onChange,
  disabled = false,
}) => {
  const [hex, setHex] = useState(value);
  const hexId = useId();
  const subject = name === '' ? 'the new label' : name;

  return (
    <Popover
      label={`Color for ${subject}`}
      trigger={(props) => (
        <button
          type="button"
          aria-label={`Change the color of ${subject}`}
          disabled={disabled}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm hover:bg-raised"
          {...props}
          onClick={() => {
            setHex(value);
            props.onClick();
          }}
        >
          <span
            aria-hidden="true"
            className="h-3 w-3 rounded-full"
            style={{ backgroundColor: value }}
          />
        </button>
      )}
      contentClassName="w-56 space-y-3 p-3"
    >
      {(close) => (
        <>
          <div
            role="radiogroup"
            aria-label="Color"
            className="grid grid-cols-7 gap-1.5"
          >
            {STATUS_COLORS.map((color) => {
              const swatch = STATUS_COLOR_VALUES[color];
              const checked = swatch.toLowerCase() === value.toLowerCase();
              return (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={STATUS_COLOR_LABELS[color]}
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full transition-shadow duration-100 active:scale-95',
                    checked
                      ? 'ring-2 ring-accent ring-offset-1 ring-offset-bg'
                      : 'hover:ring-2 hover:ring-line-strong hover:ring-offset-1 hover:ring-offset-bg'
                  )}
                  onClick={() => {
                    onChange(swatch);
                    close();
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="h-4 w-4 rounded-full"
                    style={{ backgroundColor: swatch }}
                  />
                </button>
              );
            })}
          </div>
          <Field
            id={hexId}
            label="Hex color"
            value={hex}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!HEX.test(hex)}
            onChange={(event) => {
              setHex(event.target.value.trim());
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              if (!HEX.test(hex)) return;
              onChange(hex.toLowerCase());
              close();
            }}
          />
        </>
      )}
    </Popover>
  );
};

export default LabelColorPicker;
