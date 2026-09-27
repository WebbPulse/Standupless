/**
 * Sizing a textarea to its content: that it takes the full content height and
 * hides the inner scrollbar, and that with a cap it stops there and scrolls.
 */

import { describe, expect, it } from 'vitest';
import { fitToContent } from './useAutoGrow';

/** A textarea that reports `height` as the height of its content. */
const textareaOf = (height: number): HTMLTextAreaElement => {
  const element = document.createElement('textarea');
  Object.defineProperty(element, 'scrollHeight', { value: height });
  return element;
};

describe('fitToContent', () => {
  it('grows to the content with no inner scrollbar when uncapped', () => {
    const element = textareaOf(900);
    fitToContent(element);
    expect(element.style.height).toBe('900px');
    expect(element.style.overflowY).toBe('hidden');
  });

  it('grows up to the cap without scrolling', () => {
    const element = textareaOf(200);
    fitToContent(element, 320);
    expect(element.style.height).toBe('200px');
    expect(element.style.overflowY).toBe('hidden');
  });

  it('stops at the cap and scrolls past it', () => {
    const element = textareaOf(500);
    fitToContent(element, 320);
    expect(element.style.height).toBe('320px');
    expect(element.style.overflowY).toBe('auto');
  });
});
