/**
 * A quiet "via MCP" note beside a timestamp, rendered only for changes made
 * through a client other than the web app.
 */

import React from 'react';
import { viaLabel } from '../../lib/changeSource';
import { cn } from '../../lib/cn';
import type { ChangeSource } from '../../types/Api';

/** Props for ViaSource: the row's source and optional classes. */
export interface ViaSourceProps {
  source: ChangeSource | null | undefined;
  className?: string;
}

/** Renders "via MCP" in faint text, or nothing for the web and old rows. */
export const ViaSource: React.FC<ViaSourceProps> = ({
  source,
  className = '',
}) => {
  const label = viaLabel(source);
  if (label === null) return null;
  return (
    <span className={cn('text-xs text-text-faint', className)}>{label}</span>
  );
};

export default ViaSource;
