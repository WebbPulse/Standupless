/**
 * A Mermaid diagram drawn from its source, in the palette of the theme the
 * page is painted in, and redrawn when the theme changes. While the renderer
 * loads it reads as a quiet placeholder, and a diagram that does not parse
 * shows its source with a short error under it rather than breaking the page.
 * The SVG comes from Mermaid at its strict security level, already sanitised.
 */

import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  cachedMermaid,
  isPaintedDark,
  renderMermaid,
  subscribePaintedTheme,
  type MermaidResult,
} from '../../lib/mermaid';
import '../ui/mermaid.css';

/** Props for MermaidPreview: the diagram source and an optional way in to edit it. */
export interface MermaidPreviewProps {
  source: string;
  /** Called when the preview is clicked, such as to switch an editor to code. */
  onActivate?: () => void;
}

/** Whether the page is painted dark, following the theme as it changes. */
const usePaintedDark = (): boolean =>
  useSyncExternalStore(subscribePaintedTheme, isPaintedDark, () => true);

/** The drawn SVG, set from Mermaid's sanitised markup. */
const Diagram: React.FC<{ svg: string }> = ({ svg }) => {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current !== null) ref.current.innerHTML = svg;
  }, [svg]);
  return (
    <div
      ref={ref}
      className="mermaid-diagram"
      role="img"
      aria-label="Mermaid diagram"
    />
  );
};

/** Renders one diagram, or its source and error when it does not parse. */
export const MermaidPreview: React.FC<MermaidPreviewProps> = ({
  source,
  onActivate,
}) => {
  const dark = usePaintedDark();
  const [result, setResult] = useState<MermaidResult | null>(
    () => cachedMermaid(source, dark) ?? null
  );

  useEffect(() => {
    let live = true;
    void renderMermaid(source, dark).then((rendered) => {
      if (live) setResult(rendered);
    });
    return () => {
      live = false;
    };
  }, [source, dark]);

  const state = result === null ? 'loading' : result.ok ? 'ready' : 'error';
  return (
    <div
      className="mermaid-preview"
      contentEditable={false}
      data-state={state}
      data-activatable={onActivate === undefined ? undefined : 'true'}
      title={onActivate === undefined ? undefined : 'Click to edit the diagram'}
      onClick={onActivate}
    >
      {result === null && <p className="mermaid-status">Rendering diagram…</p>}
      {result?.ok === true && <Diagram svg={result.svg} />}
      {result !== null && !result.ok && (
        <>
          <pre className="mermaid-source">
            <code>{source}</code>
          </pre>
          <p className="mermaid-error" role="alert">
            {result.error}
          </p>
        </>
      )}
    </div>
  );
};

export default MermaidPreview;
