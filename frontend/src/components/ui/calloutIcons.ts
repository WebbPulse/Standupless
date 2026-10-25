/**
 * The icon each callout kind is drawn with, as Lucide outline path data, so
 * the editor's node view and the static renderer draw exactly the same mark
 * without one depending on React and the other on the DOM.
 */

import type { CalloutKind } from '../../lib/callouts';

/** The 24 by 24 outline paths of each kind's icon. */
export const CALLOUT_ICON_PATHS: Record<CalloutKind, string[]> = {
  note: [
    'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z',
    'M12 16v-4',
    'M12 8h.01',
  ],
  tip: [
    'M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5',
    'M9 18h6',
    'M10 22h4',
  ],
  important: [
    'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    'M12 7v2',
    'M12 13h.01',
  ],
  warning: [
    'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3',
    'M12 9v4',
    'M12 17h.01',
  ],
  danger: [
    'M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86L7.86 2z',
    'M12 8v4',
    'M12 16h.01',
  ],
};

/** The attributes every callout icon's `<svg>` carries. */
export const CALLOUT_ICON_ATTRIBUTES: Record<string, string> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '2',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'aria-hidden': 'true',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A kind's icon built as a DOM `<svg>`, for node views outside React. */
export const calloutIconElement = (kind: CalloutKind): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [name, value] of Object.entries(CALLOUT_ICON_ATTRIBUTES)) {
    svg.setAttribute(name, value);
  }
  for (const d of CALLOUT_ICON_PATHS[kind]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
};
