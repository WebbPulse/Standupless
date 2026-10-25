/**
 * A fenced `mermaid` block in rendered Markdown. It opens on the drawn
 * diagram, and a Code and Preview toggle on the block switches to the
 * highlighted source and back, the way Linear and GitHub show diagrams. The
 * Markdown itself stays an ordinary fenced block.
 */

import React, { useState } from 'react';
import { LuCheck, LuCopy } from 'react-icons/lu';
import { useCopy } from '../../hooks/useCopy';
import { MERMAID_LANGUAGE } from '../../lib/mermaid';
import MermaidPreview from '../editor/MermaidPreview';
import HighlightedCode from './highlighted-code';
import './codeBlock.css';
import './mermaid.css';

/** Which face of a diagram block is showing. */
export type MermaidMode = 'preview' | 'code';

/** Props for MermaidModeToggle: the showing face and how to change it. */
export interface MermaidModeToggleProps {
  mode: MermaidMode;
  onChange: (mode: MermaidMode) => void;
}

/** The faces in the order the toggle lists them. */
const MODES: [MermaidMode, string][] = [
  ['code', 'Code'],
  ['preview', 'Preview'],
];

/** The Code and Preview switch a diagram block carries. */
export const MermaidModeToggle: React.FC<MermaidModeToggleProps> = ({
  mode,
  onChange,
}) => (
  <div className="mermaid-toggle" role="group" aria-label="Diagram view">
    {MODES.map(([value, label]) => (
      <button
        key={value}
        type="button"
        className="hover:text-text"
        aria-pressed={mode === value}
        onClick={() => {
          onChange(value);
        }}
      >
        {label}
      </button>
    ))}
  </div>
);

/** Props for MermaidBlock: the diagram source. */
export interface MermaidBlockProps {
  value: string;
}

/** Renders a diagram block, preview first, with its toggle and copy button. */
export const MermaidBlock: React.FC<MermaidBlockProps> = ({ value }) => {
  const [mode, setMode] = useState<MermaidMode>('preview');
  const { copied, copy } = useCopy();
  const toggle = <MermaidModeToggle mode={mode} onChange={setMode} />;

  if (mode === 'code') {
    return (
      <HighlightedCode
        language={MERMAID_LANGUAGE}
        value={value}
        actions={toggle}
      />
    );
  }

  const copyLabel = copied ? 'Copied' : 'Copy code';
  return (
    <div className="code-block">
      <MermaidPreview source={value} />
      <div className="absolute top-1 right-1 flex items-center gap-1">
        {toggle}
        <button
          type="button"
          className="code-block-copy hover:bg-raised hover:text-text"
          aria-label={copyLabel}
          title={copyLabel}
          data-copied={String(copied)}
          onClick={() => {
            copy(value);
          }}
        >
          {copied ? (
            <LuCheck aria-hidden="true" />
          ) : (
            <LuCopy aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
};

export default MermaidBlock;
