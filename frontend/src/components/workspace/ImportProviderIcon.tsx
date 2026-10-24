/**
 * The glyph each row of the import assistant leads with. They are drawn here
 * as plain monochrome line marks in the current text colour rather than the
 * vendors' logos, so the list reads as one set and carries no trademarks. The
 * row names the provider, so the glyph is hidden from assistive technology.
 */

import React from 'react';
import { cn } from '../../lib/cn';

/** Where the import assistant can bring work over from. */
export type ImportProvider =
  'asana' | 'shortcut' | 'github' | 'jira' | 'linear' | 'file';

/** Props for ImportProviderIcon: the provider and optional extra classes. */
export interface ImportProviderIconProps {
  provider: ImportProvider;
  className?: string;
}

/** The strokes of each provider's glyph on a 16 unit grid. */
const PATHS: Record<ImportProvider, React.ReactNode> = {
  asana: (
    <>
      <path d="M2.5 4.2l1.2 1.2 2-2.2M2.5 10.2l1.2 1.2 2-2.2" />
      <path d="M8 4.5h5.5M8 10.5h5.5" />
    </>
  ),
  shortcut: <path d="M2.5 3.5L7 8l-4.5 4.5M8.5 3.5L13 8l-4.5 4.5" />,
  github: (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-6.2 4.3" />
    </>
  ),
  jira: (
    <>
      <path d="M2 4.5h12v2a1.5 1.5 0 000 3v2H2v-2a1.5 1.5 0 000-3z" />
      <path d="M10 4.5v7" strokeDasharray="1.2 1.4" />
    </>
  ),
  linear: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.5 8h5M8.5 6l2 2-2 2" />
    </>
  ),
  file: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M2.5 6.2h11M2.5 9.8h11M6.5 6.2v7.3" />
    </>
  ),
};

/** One provider's line glyph, drawn in the current text colour. */
export const ImportProviderIcon: React.FC<ImportProviderIconProps> = ({
  provider,
  className = '',
}) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    data-provider={provider}
    className={cn('h-4 w-4 shrink-0', className)}
  >
    {PATHS[provider]}
  </svg>
);

export default ImportProviderIcon;
