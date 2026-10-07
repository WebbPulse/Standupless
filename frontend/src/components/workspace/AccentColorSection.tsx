/**
 * The workspace accent setting: a row of curated swatches, a custom color
 * with its hex value, and a reset to the Standupless orange. The color applies
 * to every member, in light and dark, so a pick paints the page at once and is
 * saved straight away, the way a swatch in any other settings row behaves.
 * Only an owner or an admin reaches this page, which is what the PATCH checks.
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { updateWorkspace } from '../../api/workspaces';
import { useWorkspace } from '../../hooks/useWorkspace';
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  deriveAccentScale,
  normalizeAccent,
  paintAccent,
} from '../../lib/accent';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import type { WorkspaceRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Input from '../ui/input';

/** How long the native color picker waits after the last drag before saving. */
const CUSTOM_SAVE_DELAY_MS = 500;

/** Props for AccentColorSection. */
export interface AccentColorSectionProps {
  workspace: WorkspaceRead;
}

/** Which themes moved the picked color to keep it readable, as a sentence. */
const adjustedNote = (color: string): string | null => {
  const scale = deriveAccentScale(color);
  const light = scale.light.accent !== color;
  const dark = scale.dark.accent !== color;
  if (light && dark) return 'Adjusted in light and dark mode to stay readable.';
  if (light) return 'Darkened in light mode to stay readable.';
  if (dark) return 'Lightened in dark mode to stay readable.';
  return null;
};

/** Picks, previews and saves the workspace accent color. */
export const AccentColorSection: React.FC<AccentColorSectionProps> = ({
  workspace,
}) => {
  const { refresh } = useWorkspace();
  const saved = workspace.accent_color ?? null;
  const [current, setCurrent] = useState<string | null>(saved);
  const [hex, setHex] = useState(saved ?? DEFAULT_ACCENT);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hexId = useId();
  const pickerId = useId();

  const [syncedFrom, setSyncedFrom] = useState<string | null>(saved);
  if (syncedFrom !== saved) {
    setSyncedFrom(saved);
    setCurrent(saved);
    setHex(saved ?? DEFAULT_ACCENT);
  }

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  const commit = async (value: string | null): Promise<void> => {
    if (timer.current !== null) clearTimeout(timer.current);
    setCurrent(value);
    setHex(value ?? DEFAULT_ACCENT);
    setError(null);
    paintAccent(value);
    if (value === saved) return;
    setSaving(true);
    try {
      await updateWorkspace(workspace.id, { accent_color: value });
      await refresh();
    } catch (failure) {
      setCurrent(saved);
      setHex(saved ?? DEFAULT_ACCENT);
      paintAccent(saved);
      setError(errorMessage(failure, 'Could not save the accent color.'));
    } finally {
      setSaving(false);
    }
  };

  const commitHex = (): void => {
    const normalized = normalizeAccent(hex);
    if (normalized === null || normalized === current) return;
    void commit(normalized);
  };

  const shown = current ?? DEFAULT_ACCENT;
  const note = current === null ? null : adjustedNote(current);
  const hexValid = normalizeAccent(hex) !== null;

  return (
    <section className="space-y-4" aria-labelledby={`${pickerId}-title`}>
      <div className="space-y-1">
        <h3 id={`${pickerId}-title`} className="text-base font-semibold">
          Accent color
        </h3>
        <p className="text-sm text-text-muted">
          Used for buttons, links, focus rings and selection for everyone in
          this workspace. Status, priority and label colors keep their own.
        </p>
      </div>
      <ErrorAlert message={error} />
      <div className="divide-y divide-line rounded-md border border-line">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <span className="text-sm text-text">Preset</span>
          <div
            role="radiogroup"
            aria-label="Accent presets"
            className="flex flex-wrap items-center gap-1.5"
          >
            {ACCENT_PRESETS.map((preset) => {
              const checked = preset.value === current;
              return (
                <button
                  key={preset.name}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={preset.name}
                  title={
                    preset.value === null
                      ? `${preset.name} (default)`
                      : preset.name
                  }
                  disabled={saving}
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full transition-shadow duration-100 disabled:cursor-wait',
                    checked
                      ? 'ring-2 ring-text ring-offset-2 ring-offset-bg'
                      : 'hover:ring-1 hover:ring-line-strong hover:ring-offset-1 hover:ring-offset-bg'
                  )}
                  onClick={() => {
                    void commit(preset.value);
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="h-[18px] w-[18px] rounded-full"
                    style={{ backgroundColor: preset.swatch }}
                  />
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <label htmlFor={hexId} className="text-sm text-text">
            Custom
          </label>
          <div className="flex items-center gap-2">
            <span className="relative flex h-7 w-7 shrink-0 overflow-hidden rounded-sm border border-line-strong">
              <input
                type="color"
                aria-label="Pick a custom accent color"
                value={normalizeAccent(hex) ?? shown}
                disabled={saving}
                className="absolute -inset-2 h-11 w-11 cursor-pointer border-0 bg-transparent p-0"
                onChange={(event) => {
                  const picked = event.target.value.toLowerCase();
                  setHex(picked);
                  paintAccent(picked);
                  if (timer.current !== null) clearTimeout(timer.current);
                  timer.current = setTimeout(() => {
                    void commit(picked);
                  }, CUSTOM_SAVE_DELAY_MS);
                }}
              />
            </span>
            <Input
              id={hexId}
              value={hex}
              autoComplete="off"
              spellCheck={false}
              maxLength={7}
              aria-invalid={!hexValid}
              className="h-7 w-24 font-mono text-xs"
              onChange={(event) => {
                setHex(event.target.value.trim());
              }}
              onBlur={commitHex}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                commitHex();
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={current === null || saving}
              onClick={() => {
                void commit(null);
              }}
            >
              Reset to default
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <span className="text-sm text-text">Preview</span>
          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="inline-flex h-7 items-center rounded-sm bg-accent px-2 text-xs font-medium text-on-accent">
              Create issue
            </span>
            <span className="text-sm text-accent underline-offset-2 hover:underline">
              View link
            </span>
            <span className="inline-flex h-6 items-center rounded-sm bg-accent-soft px-2 text-xs text-text">
              Selected
            </span>
            <span className="h-1.5 w-16 overflow-hidden rounded-full bg-raised">
              <span className="block h-full w-2/3 rounded-full bg-accent" />
            </span>
          </div>
        </div>
      </div>
      {note !== null && <p className="text-xs text-text-faint">{note}</p>}
    </section>
  );
};

export default AccentColorSection;
