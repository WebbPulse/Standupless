/**
 * A callout in read-only Markdown: the kind's icon and tone beside the body,
 * drawn from the same classes and icon paths as the editor's callout node, so
 * a comment, a share page and an inbox preview show it as the editor does.
 */

import React from 'react';
import { CALLOUT_LABELS, type CalloutKind } from '../../lib/callouts';
import { CALLOUT_ICON_PATHS } from './calloutIcons';
import './callout.css';

/** Props for MarkdownCallout: the kind and the rendered body blocks. */
export interface MarkdownCalloutProps {
  kind: CalloutKind;
  children: React.ReactNode;
}

/** One callout block with its kind's icon. */
export const MarkdownCallout: React.FC<MarkdownCalloutProps> = ({
  kind,
  children,
}) => (
  <div
    className="callout"
    data-kind={kind}
    role="note"
    aria-label={CALLOUT_LABELS[kind]}
  >
    <span className="callout-icon">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {CALLOUT_ICON_PATHS[kind].map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    </span>
    <div className="callout-body">{children}</div>
  </div>
);

export default MarkdownCallout;
