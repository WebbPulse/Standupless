/**
 * Holds the diagram renderer to its contract: only a `mermaid` fence counts,
 * every render runs at the strict security level in the painted theme's
 * palette, a failed parse answers with one short line rather than throwing,
 * and a diagram drawn once is not drawn again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMermaidCache,
  isMermaidLanguage,
  isPaintedDark,
  mermaidConfig,
  renderMermaid,
  shortMermaidError,
} from './mermaid';

const { initialize, parse, render } = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn((_source: string) => Promise.resolve({})),
  render: vi.fn((id: string, _source: string) =>
    Promise.resolve({ svg: `<svg id="${id}"></svg>` })
  ),
}));

vi.mock('mermaid', () => ({
  default: { initialize, parse, render },
}));

beforeEach(() => {
  initialize.mockClear();
  parse.mockClear();
  render.mockClear();
  clearMermaidCache();
});

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('isMermaidLanguage', () => {
  it('matches the mermaid fence in any case', () => {
    expect(isMermaidLanguage('mermaid')).toBe(true);
    expect(isMermaidLanguage(' Mermaid ')).toBe(true);
    expect(isMermaidLanguage('ts')).toBe(false);
    expect(isMermaidLanguage('')).toBe(false);
    expect(isMermaidLanguage(null)).toBe(false);
    expect(isMermaidLanguage(undefined)).toBe(false);
  });
});

describe('mermaidConfig', () => {
  it('renders strictly and never on load', () => {
    const config = mermaidConfig(true);
    expect(config.securityLevel).toBe('strict');
    expect(config.startOnLoad).toBe(false);
    expect(config.theme).toBe('base');
  });

  it('draws in the palette of the painted theme', () => {
    const dark = mermaidConfig(true).themeVariables as Record<string, unknown>;
    const light = mermaidConfig(false).themeVariables as Record<
      string,
      unknown
    >;
    expect(dark['darkMode']).toBe(true);
    expect(light['darkMode']).toBe(false);
    expect(dark['primaryTextColor']).not.toBe(light['primaryTextColor']);
  });
});

describe('isPaintedDark', () => {
  it('follows the theme attribute the page carries', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    expect(isPaintedDark()).toBe(true);
    document.documentElement.setAttribute('data-theme', 'light');
    expect(isPaintedDark()).toBe(false);
  });
});

describe('shortMermaidError', () => {
  it('keeps a parse error to its position and its expectation', () => {
    const error = new Error(
      "Parse error on line 2:\n...A --> \n-------^\nExpecting 'NODE_STRING', got 'EOF'"
    );
    expect(shortMermaidError(error)).toBe(
      "Parse error on line 2: Expecting 'NODE_STRING', got 'EOF'"
    );
  });

  it('keeps a one line error as it is', () => {
    expect(shortMermaidError(new Error('No diagram type detected'))).toBe(
      'No diagram type detected'
    );
  });

  it('cuts a long error short', () => {
    const text = shortMermaidError(new Error('x'.repeat(400)));
    expect(text.length).toBe(160);
    expect(text.endsWith('…')).toBe(true);
  });

  it('falls back to a plain sentence for an error with no message', () => {
    expect(shortMermaidError({})).toBe('The diagram could not be drawn.');
  });
});

describe('renderMermaid', () => {
  it('answers with the drawn SVG', async () => {
    const result = await renderMermaid('graph TD\n  A --> B', true);
    expect(result.ok).toBe(true);
    expect(result.ok && result.svg).toContain('<svg');
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: 'strict' })
    );
  });

  it('draws a diagram shown again only once per theme', async () => {
    await renderMermaid('graph TD\n  A --> B', true);
    await renderMermaid('graph TD\n  A --> B', true);
    expect(render).toHaveBeenCalledTimes(1);
    await renderMermaid('graph TD\n  A --> B', false);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('answers with a short error when the source does not parse', async () => {
    parse.mockRejectedValueOnce(new Error('Parse error on line 1:\nboom'));
    const result = await renderMermaid('not a diagram', true);
    expect(result).toEqual({
      ok: false,
      error: 'Parse error on line 1: boom',
    });
    expect(render).not.toHaveBeenCalled();
  });

  it('does not load the renderer for an empty block', async () => {
    const result = await renderMermaid('   ', true);
    expect(result.ok).toBe(false);
    expect(parse).not.toHaveBeenCalled();
  });

  it('removes what a failed render left in the document', async () => {
    render.mockImplementationOnce((id: string) => {
      const stray = document.createElement('div');
      stray.id = `d${id}`;
      document.body.append(stray);
      return Promise.reject(new Error('render failed'));
    });
    const result = await renderMermaid('graph LR\n  X --> Y', true);
    expect(result).toEqual({ ok: false, error: 'render failed' });
    expect(document.body.querySelector('[id^="dstandupless-mermaid"]')).toBe(
      null
    );
  });
});
