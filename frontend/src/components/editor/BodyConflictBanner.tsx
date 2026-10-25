/**
 * The notice a description or document editor shows when its save was
 * refused because someone else edited the text since it was opened. The
 * person's own text stays in the editor until they choose: load the other
 * version, with their text copied to the clipboard first so nothing is lost,
 * or keep theirs and save it over the other version on purpose.
 */

import React from 'react';
import { Button } from '../ui/button';

/** Props for BodyConflictBanner: the two ways out of the conflict. */
export interface BodyConflictBannerProps {
  /** Copies the person's text to the clipboard, then shows the other version. */
  onLoadTheirs: () => void;
  /** Saves the person's text over the other version. */
  onKeepMine: () => void;
  /** Disables both choices while one is being carried out. */
  busy?: boolean;
}

/** The stale save notice with its two choices. */
export const BodyConflictBanner: React.FC<BodyConflictBannerProps> = ({
  onLoadTheirs,
  onKeepMine,
  busy = false,
}) => (
  <div
    role="alert"
    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface px-3 py-2 text-sm text-text"
  >
    <span>Someone else edited this. Your changes are not saved yet.</span>
    <span className="flex gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={onLoadTheirs}
      >
        Load their version
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={onKeepMine}
      >
        Keep mine
      </Button>
    </span>
  </div>
);

export default BodyConflictBanner;
