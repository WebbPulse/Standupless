/** Publishes the shortcut registry's bound keys for tests to wait on. */

import { useRegisteredShortcuts } from '../hooks/useShortcuts';

/** Publishes the key sequences the shortcut layer has bound right now. */
export const BoundKeys = () => {
  const bound = useRegisteredShortcuts();
  return (
    <output
      data-testid="bound-keys"
      data-keys={bound.map((shortcut) => shortcut.keys).join('|')}
    />
  );
};

export default BoundKeys;
