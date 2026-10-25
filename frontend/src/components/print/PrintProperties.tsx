/**
 * A page's key properties as one line of text, shown only when it prints,
 * where the property panels and chips are left out.
 */

import React from 'react';

/** Props for PrintProperties. */
export interface PrintPropertiesProps {
  /** Each property as it reads, empty ones dropped. */
  items: readonly (string | null | undefined)[];
}

/** Renders the line, or nothing when every item is empty. */
export const PrintProperties: React.FC<PrintPropertiesProps> = ({ items }) => {
  const shown = items.filter(
    (item): item is string => item !== null && item !== undefined && item !== ''
  );
  if (shown.length === 0) return null;
  return (
    <p
      data-testid="print-properties"
      className="print-only text-xs text-text-muted"
    >
      {shown.join(' · ')}
    </p>
  );
};

export default PrintProperties;
