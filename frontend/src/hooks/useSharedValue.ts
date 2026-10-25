/**
 * Holds a polled value steady across polls that answer with equal content,
 * through {@link shareEqual}, so the memos and rows reading it render again
 * only for the parts that changed.
 */

import { useEffect, useMemo, useRef } from 'react';
import { shareEqual } from '../lib/shareEqual';

/**
 * The value, with every part equal to the last value handed back kept as the
 * object handed back then. The comparison runs only when the value's identity
 * changes, so a render for anything else costs nothing.
 */
export const useSharedValue = <T>(value: T): T => {
  const held = useRef<T>(value);
  const shared = useMemo(() => shareEqual(held.current, value), [value]);
  useEffect(() => {
    held.current = shared;
  }, [shared]);
  return shared;
};

export default useSharedValue;
