/**
 * The glyphs that stand for each kind of issue relation, drawn here on the same
 * 14px grid as the status and priority glyphs so they sit on a row's centre
 * line beside them. A blocked issue carries a solid flag and a blocking one a
 * flag with a hollow pennant, so the two differ in shape as well as colour,
 * which comes from the warning and danger tokens; related and duplicate
 * glyphs take the text colour they are given. Every glyph paints with
 * `currentColor` and cuts its holes with an even-odd fill, so a hover
 * background behind it shows through rather than a fixed knockout colour.
 */

import React from 'react';
import type { LinkType, LinkTypeRead } from '../../types/Api';
import { cn } from '../../lib/cn';

/** Props every relation glyph takes: any SVG attribute plus a class. */
export type RelationGlyphProps = React.SVGAttributes<SVGElement> & {
  className?: string;
};

/** The pole every flag glyph stands on. */
const POLE =
  'M2.6 1.6a.85.85 0 0 1 .85.85v9.7a.85.85 0 0 1-1.7 0v-9.7a.85.85 0 0 1 .85-.85Z';

/** A pennant with a notched fly, hung from the top of the pole. */
const PENNANT =
  'M3.2 2.1h8.25a.6.6 0 0 1 .47.97L9.95 5.6l1.97 2.53a.6.6 0 0 1-.47.97H3.2Z';

/** The hollow a blocking flag has cut out of its pennant, leaving an outline. */
const PENNANT_HOLE = 'M4.55 3.45h5.6L8.55 5.6l1.6 2.15h-5.6Z';

/** Shared SVG frame: the 14px grid, decorative unless the caller names it. */
const Frame: React.FC<RelationGlyphProps & { children: React.ReactNode }> = ({
  className,
  children,
  ...props
}) => (
  <svg
    viewBox="0 0 14 14"
    fill="currentColor"
    aria-hidden={props.role === 'img' ? undefined : true}
    className={cn('h-3.5 w-3.5 shrink-0', className)}
    {...props}
  >
    {children}
  </svg>
);

/** A solid flag: this issue is blocked by another that is still open. */
export const BlockedGlyph: React.FC<RelationGlyphProps> = (props) => (
  <Frame {...props}>
    <path d={POLE} />
    <path d={PENNANT} />
  </Frame>
);

/** A flag with a hollow pennant: this issue blocks others. */
export const BlockingGlyph: React.FC<RelationGlyphProps> = (props) => (
  <Frame {...props}>
    <path d={POLE} />
    <path
      d={`${PENNANT}${PENNANT_HOLE}`}
      fillRule="evenodd"
      clipRule="evenodd"
    />
  </Frame>
);

/** Two linked nodes: the issues relate without either blocking the other. */
export const RelatedGlyph: React.FC<RelationGlyphProps> = (props) => (
  <Frame {...props}>
    <path d="M3.75 7.5a2.25 2.25 0 1 1 0 4.5 2.25 2.25 0 0 1 0-4.5ZM10.25 2a2.25 2.25 0 1 1 0 4.5 2.25 2.25 0 0 1 0-4.5Z" />
    <path
      d="M5.2 8.8 8.8 5.2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </Frame>
);

/** Two stacked cards: one issue repeats another. */
export const DuplicateGlyph: React.FC<RelationGlyphProps> = (props) => (
  <Frame {...props}>
    <rect
      x="4.65"
      y="1.65"
      width="7.7"
      height="7.7"
      rx="1.9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    />
    <rect x="1.5" y="4.5" width="8" height="8" rx="2" />
  </Frame>
);

/** The colour class of the blocked glyph. */
export const BLOCKED_TONE = 'text-danger';

/** The colour class of the blocking glyph. */
export const BLOCKING_TONE = 'text-warning';

/** The blocked flag in its theme colour, for a menu or command icon slot. */
export const BlockedIcon: React.FC<RelationGlyphProps> = ({
  className,
  ...props
}) => <BlockedGlyph className={cn(BLOCKED_TONE, className)} {...props} />;

/** The blocking flag in its theme colour, for a menu or command icon slot. */
export const BlockingIcon: React.FC<RelationGlyphProps> = ({
  className,
  ...props
}) => <BlockingGlyph className={cn(BLOCKING_TONE, className)} {...props} />;

/** The glyph and colour class for one relation type, shared by every surface. */
export const RELATION_GLYPHS: Record<
  LinkTypeRead,
  { glyph: React.FC<RelationGlyphProps>; tone: string }
> = {
  blocked_by: { glyph: BlockedGlyph, tone: BLOCKED_TONE },
  blocks: { glyph: BlockingGlyph, tone: BLOCKING_TONE },
  relates_to: { glyph: RelatedGlyph, tone: 'text-text-faint' },
  duplicate_of: { glyph: DuplicateGlyph, tone: 'text-text-faint' },
  duplicated_by: { glyph: DuplicateGlyph, tone: 'text-text-faint' },
};

/** Props for RelationGlyph: the relation type and an optional class. */
export interface RelationGlyphForProps {
  type: LinkTypeRead;
  className?: string;
}

/** The glyph for one relation type in its own colour, always decorative. */
export const RelationGlyph: React.FC<RelationGlyphForProps> = ({
  type,
  className,
}) => {
  const entry = RELATION_GLYPHS[type] ?? RELATION_GLYPHS.relates_to;
  const Glyph = entry.glyph;
  return <Glyph className={cn(entry.tone, className)} />;
};

/** One "Mark as" command: its keys, its label and the relation it starts on. */
export interface RelationCommand {
  keys: string;
  label: string;
  type: LinkType;
  icon: React.FC<RelationGlyphProps>;
}

/**
 * The "Mark as" commands in menu order, shared by the issue page and the
 * issue list so a row in focus takes the same keys the page does.
 */
export const RELATION_COMMANDS: readonly RelationCommand[] = [
  {
    keys: 'm b',
    label: 'Mark as blocked by',
    type: 'blocked_by',
    icon: BlockedIcon,
  },
  {
    keys: 'm x',
    label: 'Mark as blocking',
    type: 'blocks',
    icon: BlockingIcon,
  },
  {
    keys: 'm r',
    label: 'Mark as related to',
    type: 'relates_to',
    icon: RelatedGlyph,
  },
  {
    keys: 'm m',
    label: 'Mark as duplicate of',
    type: 'duplicate_of',
    icon: DuplicateGlyph,
  },
];
