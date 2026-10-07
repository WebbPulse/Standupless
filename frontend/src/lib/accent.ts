/**
 * The workspace accent: one #rrggbb an admin picks, turned into the accent
 * token scale for the light and the dark theme.
 *
 * The stylesheet's own tokens stay the default. A chosen accent is written as
 * `--ws-<theme>-*` properties on the document element beside a `data-accent`
 * attribute, and `accent.css` points the app tokens at them only while that
 * attribute is set, so clearing the accent is removing the attribute.
 *
 * Every derived base keeps WCAG AA text contrast (4.5:1) against each surface
 * of its theme, because the accent is drawn as link text and as a focus ring
 * on all of them. A color that falls short is moved along its own lightness,
 * darker on light and lighter on dark, by the least amount that passes, so the
 * hue an admin picked survives.
 *
 * The scale is cached per workspace slug in this browser, and the pre-paint
 * script in index.html applies it before the bundle loads, so a workspace
 * page never flashes the default orange first.
 */

/** The stored form of an accent: six lowercase hex digits after a `#`. */
const HEX_PATTERN = /^#[0-9a-f]{6}$/;

/** The text contrast every derived base and on-accent pair must keep. */
export const TEXT_CONTRAST = 4.5;

/** The two painted themes a scale is derived for. */
export type AccentTheme = 'light' | 'dark';

/** The surfaces accent text and rings sit on, per theme, from index.css. */
export const ACCENT_SURFACES: Record<
  AccentTheme,
  readonly [string, ...string[]]
> = {
  light: ['#ffffff', '#f7f7f8', '#efeff2'],
  dark: ['#141518', '#1b1c20', '#232429', '#26272c'],
};

/** The text drawn on a filled accent, per theme. */
const ON_ACCENT: Record<AccentTheme, string> = {
  light: '#ffffff',
  dark: '#141518',
};

/** How far the hover shade moves from the base, in HSL lightness. */
const STRONG_STEP = 0.08;

/** How much of the base the subtle background carries over the page, per theme. */
const SOFT_WEIGHT: Record<AccentTheme, number> = { light: 0.12, dark: 0.2 };

/** The token values for one theme. */
export interface AccentTokens {
  /** Filled controls, links, active navigation and progress. */
  accent: string;
  /** The hover shade of a filled control. */
  accentStrong: string;
  /** Selection and subtle accent backgrounds. */
  accentSoft: string;
  /** Text and icons drawn on a filled accent. */
  onAccent: string;
  /** The focus ring. */
  focus: string;
}

/** The token values for both themes. */
export interface AccentScale {
  light: AccentTokens;
  dark: AccentTokens;
}

/** A curated accent an admin can pick in one click. */
export interface AccentPreset {
  /** The name read out for the swatch. */
  name: string;
  /** The stored value, or null for the Standupless default. */
  value: string | null;
  /** The color the swatch is drawn in. */
  swatch: string;
}

/** The Standupless orange, which is what a null accent means. */
export const DEFAULT_ACCENT = '#b8451a';

/** The presets the picker offers, the default first. */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { name: 'Standupless orange', value: null, swatch: DEFAULT_ACCENT },
  { name: 'Red', value: '#d1343c', swatch: '#d1343c' },
  { name: 'Pink', value: '#d63384', swatch: '#d63384' },
  { name: 'Violet', value: '#8b5cf6', swatch: '#8b5cf6' },
  { name: 'Indigo', value: '#4f63e8', swatch: '#4f63e8' },
  { name: 'Blue', value: '#1f7ae0', swatch: '#1f7ae0' },
  { name: 'Teal', value: '#0f8f86', swatch: '#0f8f86' },
  { name: 'Green', value: '#2f9e44', swatch: '#2f9e44' },
];

/**
 * The accent as lowercase #rrggbb, or null when it is not one. A missing `#`
 * is forgiven so a value pasted from a design tool works, as the API does.
 */
export const normalizeAccent = (value: string): string | null => {
  const trimmed = value.trim().toLowerCase();
  const candidate = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return HEX_PATTERN.test(candidate) ? candidate : null;
};

type Rgb = [number, number, number];

const toRgb = (hex: string): Rgb => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const mapRgb = ([r, g, b]: Rgb, through: (channel: number) => number): Rgb => [
  through(r),
  through(g),
  through(b),
];

const toHex = (rgb: Rgb): string =>
  `#${mapRgb(rgb, (channel) => Math.round(Math.min(255, Math.max(0, channel))))
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`;

const linear = (channel: number): number => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

/** The WCAG relative luminance of a color. */
export const luminance = (hex: string): number => {
  const [r, g, b] = mapRgb(toRgb(hex), linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** The WCAG contrast ratio between two colors. */
export const contrast = (first: string, second: string): number => {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

/** The lowest contrast a color keeps against a set of surfaces. */
export const worstContrast = (
  hex: string,
  surfaces: readonly string[]
): number => Math.min(...surfaces.map((surface) => contrast(hex, surface)));

type Hsl = [number, number, number];

const toHsl = (hex: string): Hsl => {
  const [r, g, b] = mapRgb(toRgb(hex), (channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation =
    lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue =
    max === r
      ? ((g - b) / delta + (g < b ? 6 : 0)) / 6
      : max === g
        ? ((b - r) / delta + 2) / 6
        : ((r - g) / delta + 4) / 6;
  return [hue, saturation, lightness];
};

const fromHsl = ([hue, saturation, lightness]: Hsl): string => {
  if (saturation === 0) {
    return toHex([lightness * 255, lightness * 255, lightness * 255]);
  }
  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const channel = (offset: number): number => {
    let t = hue + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return toHex([channel(1 / 3) * 255, channel(0) * 255, channel(-1 / 3) * 255]);
};

const withLightness = (hex: string, lightness: number): string => {
  const [hue, saturation] = toHsl(hex);
  return fromHsl([hue, saturation, Math.min(1, Math.max(0, lightness))]);
};

/**
 * The color moved along its own lightness, darker on light and lighter on
 * dark, by the least amount that keeps text contrast against every surface of
 * the theme. A color that already passes comes back unchanged.
 */
export const clampForContrast = (hex: string, theme: AccentTheme): string => {
  const surfaces = ACCENT_SURFACES[theme];
  if (worstContrast(hex, surfaces) >= TEXT_CONTRAST) return hex;
  const start = toHsl(hex)[2];
  const target = theme === 'light' ? 0 : 1;
  let passing = target;
  let failing = start;
  for (let step = 0; step < 24; step += 1) {
    const middle = (passing + failing) / 2;
    if (worstContrast(withLightness(hex, middle), surfaces) >= TEXT_CONTRAST) {
      passing = middle;
    } else {
      failing = middle;
    }
  }
  const nudge = theme === 'light' ? -0.002 : 0.002;
  let clamped = withLightness(hex, passing);
  while (
    worstContrast(clamped, surfaces) < TEXT_CONTRAST &&
    passing !== target
  ) {
    passing =
      theme === 'light'
        ? Math.max(0, passing + nudge)
        : Math.min(1, passing + nudge);
    clamped = withLightness(hex, passing);
  }
  return clamped;
};

const mix = (hex: string, over: string, weight: number): string => {
  const [r, g, b] = toRgb(hex);
  const under = toRgb(over);
  return toHex([
    r * weight + under[0] * (1 - weight),
    g * weight + under[1] * (1 - weight),
    b * weight + under[2] * (1 - weight),
  ]);
};

/** The token values one accent produces in one theme. */
export const deriveAccentTokens = (
  hex: string,
  theme: AccentTheme
): AccentTokens => {
  const accent = clampForContrast(hex, theme);
  const lightness = toHsl(accent)[2];
  const accentStrong = withLightness(
    accent,
    theme === 'light' ? lightness - STRONG_STEP : lightness + STRONG_STEP
  );
  return {
    accent,
    accentStrong,
    accentSoft: mix(accent, ACCENT_SURFACES[theme][0], SOFT_WEIGHT[theme]),
    onAccent: ON_ACCENT[theme],
    focus: theme === 'light' ? accent : accentStrong,
  };
};

/** The token values one accent produces in both themes. */
export const deriveAccentScale = (hex: string): AccentScale => ({
  light: deriveAccentTokens(hex, 'light'),
  dark: deriveAccentTokens(hex, 'dark'),
});

const TOKEN_NAMES: Record<keyof AccentTokens, string> = {
  accent: 'accent',
  accentStrong: 'accent-strong',
  accentSoft: 'accent-soft',
  onAccent: 'on-accent',
  focus: 'focus',
};

/** The custom properties a scale is written as, keyed by property name. */
export const accentProperties = (
  scale: AccentScale
): Record<string, string> => {
  const properties: Record<string, string> = {};
  for (const theme of ['light', 'dark'] as const) {
    for (const [key, name] of Object.entries(TOKEN_NAMES)) {
      properties[`--ws-${theme}-${name}`] =
        scale[theme][key as keyof AccentTokens];
    }
  }
  return properties;
};

/** The attribute that switches the stylesheet over to the workspace accent. */
export const ACCENT_ATTRIBUTE = 'data-accent';

/** The storage key the pre-paint script in index.html reads too. */
export const ACCENT_STORAGE_KEY = 'standupless-accent';

const ALL_PROPERTIES = Object.keys(
  accentProperties(deriveAccentScale(DEFAULT_ACCENT))
);

/**
 * Paints a workspace accent on the document, or with null returns it to the
 * stylesheet default.
 */
export const paintAccent = (value: string | null | undefined): void => {
  const root = globalThis.document.documentElement;
  const normalized =
    value === null || value === undefined ? null : normalizeAccent(value);
  if (normalized === null) {
    root.removeAttribute(ACCENT_ATTRIBUTE);
    for (const name of ALL_PROPERTIES) root.style.removeProperty(name);
    return;
  }
  for (const [name, color] of Object.entries(
    accentProperties(deriveAccentScale(normalized))
  )) {
    root.style.setProperty(name, color);
  }
  root.setAttribute(ACCENT_ATTRIBUTE, normalized);
};

const readCache = (): Record<string, Record<string, string>> => {
  try {
    const held: unknown = JSON.parse(
      globalThis.localStorage.getItem(ACCENT_STORAGE_KEY) ?? '{}'
    );
    return held !== null && typeof held === 'object' && !Array.isArray(held)
      ? (held as Record<string, Record<string, string>>)
      : {};
  } catch {
    return {};
  }
};

/**
 * Remembers a workspace's derived accent under its slug for the pre-paint
 * script, or forgets it on null, ignoring a storage that refuses the write.
 */
export const rememberAccent = (
  slug: string,
  value: string | null | undefined
): void => {
  const cache = readCache();
  const normalized =
    value === null || value === undefined ? null : normalizeAccent(value);
  if (normalized === null) {
    if (!(slug in cache)) return;
    delete cache[slug];
  } else {
    cache[slug] = accentProperties(deriveAccentScale(normalized));
  }
  try {
    globalThis.localStorage.setItem(ACCENT_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    return;
  }
};
