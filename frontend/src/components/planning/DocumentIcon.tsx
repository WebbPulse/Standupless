/**
 * The mark a document leads with: the emoji it picked, the glyph it picked in
 * the project icon set, or the plain page glyph when it has picked neither.
 * Lists, favorites, the palette and the page header all draw it the same.
 */

import React from 'react';
import { LuFileText } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { PROJECT_ICON_GLYPHS } from '../../lib/projectLook';
import type { ProjectIconName } from '../../types/Api';

/** Whether a stored icon names a glyph rather than holding an emoji. */
export const isGlyphIcon = (icon: string): icon is ProjectIconName =>
  Object.hasOwn(PROJECT_ICON_GLYPHS, icon);

/** Props for DocumentIcon. */
export interface DocumentIconProps {
  icon?: string | null;
  /** Sizes the glyph; an emoji is sized from the same box. */
  className?: string;
}

/** A decorative document mark. */
export const DocumentIcon: React.FC<DocumentIconProps> = ({
  icon = null,
  className = 'h-3.5 w-3.5',
}) => {
  if (icon === null || icon === '') {
    return (
      <LuFileText
        aria-hidden="true"
        data-document-icon=""
        className={cn('shrink-0 text-text-faint', className)}
      />
    );
  }
  if (isGlyphIcon(icon)) {
    const Glyph = PROJECT_ICON_GLYPHS[icon];
    return (
      <Glyph
        aria-hidden="true"
        data-document-icon={icon}
        className={cn('shrink-0 text-text-muted', className)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      data-document-icon={icon}
      className={cn(
        'inline-flex shrink-0 items-center justify-center leading-none',
        className
      )}
    >
      <span className="text-[0.9em]">{icon}</span>
    </span>
  );
};

export default DocumentIcon;
