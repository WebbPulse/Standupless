/**
 * Callout kinds and the GitHub alert syntax they are stored in. A callout is a
 * quote whose first line is a marker such as `> [!NOTE]`, so GitHub, the API,
 * MCP and exports all read the same block the editor and the static renderer
 * draw. Each kind maps to exactly one GitHub marker, so a callout synced from
 * GitHub keeps its kind on the way back.
 */

/** The kinds a callout can be, in the order the kind switcher lists them. */
export const CALLOUT_KINDS = [
  'note',
  'tip',
  'important',
  'warning',
  'danger',
] as const;

/** One callout kind. */
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/** The kind a new callout starts as. */
export const DEFAULT_CALLOUT_KIND: CalloutKind = 'note';

/** The name each kind is shown with. */
export const CALLOUT_LABELS: Record<CalloutKind, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  danger: 'Danger',
};

/** The GitHub alert type each kind is written as. */
const MARKERS: Record<CalloutKind, string> = {
  note: 'NOTE',
  tip: 'TIP',
  important: 'IMPORTANT',
  warning: 'WARNING',
  danger: 'CAUTION',
};

/** A GitHub alert marker line, with any text that follows it on the line. */
const MARKER_LINE = /^\[!(note|tip|important|warning|caution)\][ \t]*(.*)$/i;

/** Whether a value names a callout kind. */
export const isCalloutKind = (value: unknown): value is CalloutKind =>
  typeof value === 'string' &&
  (CALLOUT_KINDS as readonly string[]).includes(value);

/** The marker a kind is written with, such as `[!NOTE]`. */
export const calloutMarker = (kind: CalloutKind): string =>
  `[!${MARKERS[kind]}]`;

/** A quote's body read as a callout: its kind and the Markdown inside. */
export interface CalloutMatch {
  kind: CalloutKind;
  body: string;
}

/**
 * The callout a quote's body is, or null when its first line is not a GitHub
 * alert marker. Text after the marker on the same line opens the body.
 */
export const calloutFromQuote = (lines: string[]): CalloutMatch | null => {
  const [first, ...rest] = lines;
  const marker = MARKER_LINE.exec((first ?? '').trim());
  if (marker === null) return null;
  const type = (marker[1] ?? '').toUpperCase();
  const kind =
    CALLOUT_KINDS.find((candidate) => MARKERS[candidate] === type) ??
    DEFAULT_CALLOUT_KIND;
  const trailing = (marker[2] ?? '').trim();
  const body = (trailing === '' ? rest : [trailing, ...rest])
    .join('\n')
    .replace(/^\s*\n/, '')
    .trimEnd();
  return { kind, body };
};

/**
 * A callout written as a GitHub alert: the marker line, then each line of the
 * body behind `> `, with blank lines kept as a bare `>`.
 */
export const writeCallout = (kind: CalloutKind, body: string): string => {
  const inner = body.replace(/^\s*\n/, '').trimEnd();
  const lines =
    inner === ''
      ? []
      : inner
          .split('\n')
          .map((line) => (line.trim() === '' ? '>' : `> ${line}`));
  return [`> ${calloutMarker(kind)}`, ...lines].join('\n');
};
