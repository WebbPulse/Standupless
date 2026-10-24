/**
 * The highlighter with lowlight's common language set, loaded on demand by
 * `lib/highlight.ts` so it lands in a chunk of its own.
 */

import { common, createLowlight } from 'lowlight';

/** The highlighter every code block shares. */
export const lowlight = createLowlight(common);
