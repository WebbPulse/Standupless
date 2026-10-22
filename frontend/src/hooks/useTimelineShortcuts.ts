/**
 * The keys every project timeline answers: minus and equals step the zoom
 * out and in, and T scrolls back to today. Shared by the roadmap and the
 * projects page so both timelines read the same keys.
 */

import { stepZoom, type TimelineZoom } from '../lib/timeline';
import { useShortcut } from './useShortcuts';

/** What the timeline keys act on. */
export interface TimelineShortcutOptions {
  zoom: TimelineZoom;
  onZoomChange: (zoom: TimelineZoom) => void;
  onToday: () => void;
  /** The heading the keys are listed under in the shortcuts help. */
  group: string;
  enabled?: boolean;
}

/** The zoom and today keys of a timeline, listed under the page's group. */
export const useTimelineShortcuts = ({
  zoom,
  onZoomChange,
  onToday,
  group,
  enabled = true,
}: TimelineShortcutOptions): void => {
  const zoomBy = (step: number): void => {
    const next = stepZoom(zoom, step);
    if (next !== zoom) onZoomChange(next);
  };
  useShortcut({
    keys: '-',
    label: 'Zoom out',
    group,
    enabled,
    handler: () => {
      zoomBy(1);
    },
  });
  useShortcut({
    keys: '=',
    label: 'Zoom in',
    group,
    enabled,
    handler: () => {
      zoomBy(-1);
    },
  });
  useShortcut({
    keys: 't',
    label: 'Scroll to today',
    group,
    enabled,
    handler: onToday,
  });
};

export default useTimelineShortcuts;
