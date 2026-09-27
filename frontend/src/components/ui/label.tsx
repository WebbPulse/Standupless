/**
 * The label above a form control, and the same text hidden when a control is
 * placed where its purpose is already obvious, such as a filter bar.
 */

import React from 'react';
import { cn } from '../../lib/cn';

/** Props for Label: the native label props plus whether to hide it visually. */
export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  hidden?: boolean;
}

/** A small, medium weight label. */
export const Label: React.FC<LabelProps> = ({
  hidden = false,
  className = '',
  ...props
}) => (
  <label
    className={cn(
      hidden ? 'sr-only' : 'block text-xs font-medium text-text-muted',
      className
    )}
    {...props}
  />
);

export default Label;
