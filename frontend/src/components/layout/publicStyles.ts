/**
 * The shared class strings and section list for the public pages, kept apart
 * from the shell component so the page files can import them without breaking
 * fast refresh.
 */

import { cn } from '../../lib/cn';

/** The centred container every public section lines up with. */
export const PUBLIC_CONTAINER =
  'mx-auto w-full max-w-[1280px] px-4 sm:px-6 lg:px-8';

const PILL_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-full font-medium whitespace-nowrap transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

/** The filled pill for the main action on a public page. */
export const PILL_PRIMARY = cn(
  PILL_BASE,
  'bg-accent text-on-accent hover:bg-accent-strong'
);

/** The outlined pill for the second action beside it. */
export const PILL_SECONDARY = cn(
  PILL_BASE,
  'border border-line-strong text-text hover:bg-raised'
);

/** One section of the home page the bar links to. */
export interface PublicSectionLink {
  id: string;
  label: string;
}

/** The home page sections, in page order, that the bar and footer link to. */
export const PUBLIC_SECTIONS: PublicSectionLink[] = [
  { id: 'features', label: 'Features' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'github', label: 'GitHub' },
  { id: 'api', label: 'API' },
];
