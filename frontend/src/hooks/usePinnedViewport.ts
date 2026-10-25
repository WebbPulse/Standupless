/**
 * Keeps the document scrolled to its origin while the signed in app shell is
 * mounted, so the shell's top bar can never be left above the screen.
 *
 * The shell owns all scrolling through its inner panes and the document is
 * locked with `overflow: hidden`, but a locked document can still be scrolled
 * by script: `scrollIntoView`, focusing a field and the on screen keyboard all
 * move it, and the lock then leaves the reader no gesture to scroll it back.
 * Mobile Safari is where this bites, because its `100vh` is the viewport with
 * the toolbars retracted, taller than the visible one.
 */

import { useEffect } from 'react';

/** How far the visual viewport must shrink before a keyboard is assumed open. */
const KEYBOARD_THRESHOLD = 120;

/** Whether an element takes typed text, so focusing it raises a keyboard. */
export const isTextEntry = (element: Element | null): boolean => {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement) return !element.readOnly;
  if (element instanceof HTMLSelectElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  if (element.readOnly || element.disabled) return false;
  return ![
    'button',
    'checkbox',
    'color',
    'file',
    'hidden',
    'image',
    'radio',
    'range',
    'reset',
    'submit',
  ].includes(element.type);
};

/**
 * Whether the browser may be holding the document scrolled for the on screen
 * keyboard, so the offset has to be left alone. A focused text field counts as
 * a keyboard, opening or open, because the visual viewport only shrinks once
 * the keyboard has finished animating in. When the visual viewport has just
 * resized back to full height the keyboard is known to be closed, even if the
 * field kept focus, as it does when the keyboard is swiped away.
 */
export const isKeyboardHolding = (viewportResized = false): boolean => {
  if (!isTextEntry(document.activeElement)) return false;
  const visual = window.visualViewport;
  if (!viewportResized || visual == null) return true;
  return window.innerHeight - visual.height > KEYBOARD_THRESHOLD;
};

/**
 * Scrolls the document back to its origin when it has moved and no keyboard
 * needs the offset. Answers whether it had to.
 */
export const restoreDocumentScroll = (viewportResized = false): boolean => {
  if (window.scrollX === 0 && window.scrollY === 0) return false;
  if (isKeyboardHolding(viewportResized)) return false;
  window.scrollTo(0, 0);
  return true;
};

/**
 * Pins the document at its origin for as long as the calling component is
 * mounted. It checks on every document scroll, when focus leaves a field and
 * when the visual viewport resizes, which is when a keyboard closes.
 */
export const usePinnedViewport = (): void => {
  useEffect(() => {
    let frame = 0;
    let resized = false;
    const check = (): void => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const viewportResized = resized;
        resized = false;
        restoreDocumentScroll(viewportResized);
      });
    };
    const onResize = (): void => {
      resized = true;
      check();
    };
    const visual = window.visualViewport;
    restoreDocumentScroll();
    window.addEventListener('scroll', check, { passive: true });
    document.addEventListener('focusout', check);
    visual?.addEventListener('resize', onResize);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', check);
      document.removeEventListener('focusout', check);
      visual?.removeEventListener('resize', onResize);
    };
  }, []);
};
