/**
 * A LaTeX equation in rendered Markdown, inline or as a display block. It
 * reads as its source in a quiet monospace while KaTeX loads, and an equation
 * that does not parse keeps showing its source in the error style, with the
 * reason on hover, rather than breaking the page. The markup comes from KaTeX
 * with `trust` off, so no link, image or HTML command reaches the page. It
 * carries its stored form on `data-md`, so a quoted selection keeps the LaTeX.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  cachedMath,
  renderMath,
  writeBlockMath,
  writeInlineMath,
  type MathResult,
} from '../../lib/math';
import './math.css';

/** Props for MathFormula: the LaTeX and whether it is a display block. */
export interface MathFormulaProps {
  latex: string;
  display: boolean;
}

/** Renders one equation, or its source while loading or when it fails. */
export const MathFormula: React.FC<MathFormulaProps> = ({ latex, display }) => {
  const ref = useRef<HTMLElement>(null);
  const [result, setResult] = useState<MathResult | null>(
    () => cachedMath(latex, display) ?? null
  );

  useEffect(() => {
    let live = true;
    void renderMath(latex, display).then((rendered) => {
      if (live) setResult(rendered);
    });
    return () => {
      live = false;
    };
  }, [latex, display]);

  const html = result?.ok === true ? result.html : null;
  useLayoutEffect(() => {
    if (ref.current !== null && html !== null) ref.current.innerHTML = html;
  }, [html]);

  const state = result === null ? 'loading' : result.ok ? 'ready' : 'error';
  const source = display ? latex : writeInlineMath(latex);
  return React.createElement(
    display ? 'div' : 'span',
    {
      ref,
      key: state,
      className: display ? 'math-block' : 'math-inline',
      'data-state': state,
      'data-md': display ? `\n\n${writeBlockMath(latex)}\n\n` : source,
      title: result !== null && !result.ok ? result.error : undefined,
      role: state === 'ready' ? undefined : 'math',
      'aria-label': state === 'ready' ? undefined : latex,
    },
    state === 'ready' ? null : source
  );
};

export default MathFormula;
