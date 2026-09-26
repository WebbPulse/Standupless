/**
 * Owns the workspace's shortcut registry and the one document listener that
 * feeds it. Mounted once by the workspace layout, so every page and every
 * overlay under `/w/:slug` registers into the same place and a sequence such
 * as `g i` survives the page it started on re-rendering.
 */

import React, { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
} from '../../hooks/useShortcuts';

/** Props for ShortcutProvider: the subtree the shortcuts apply to. */
export interface ShortcutProviderProps {
  children: ReactNode;
}

/** Provides a registry and routes every keydown on the document through it. */
export const ShortcutProvider: React.FC<ShortcutProviderProps> = ({
  children,
}) => {
  const [registry] = useState(() => createShortcutRegistry());

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      registry.handleKey(event);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [registry]);

  return (
    <ShortcutRegistryContext.Provider value={registry}>
      {children}
    </ShortcutRegistryContext.Provider>
  );
};

export default ShortcutProvider;
