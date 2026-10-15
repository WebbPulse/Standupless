/**
 * The cold start screen and the static copy in index.html must be the same
 * screen, so the swap from one to the other neither jumps nor flashes: the same
 * mark at the same size, the same spinner turning at the same rate and phase,
 * and the static copy retired in the commit that first renders the app.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOOT_SPLASH_MARK_SIZE,
  BOOT_SPLASH_PERIOD_MS,
  STATIC_BOOT_SPLASH_ID,
  bootSplashPhase,
} from '../../lib/bootSplash';
import { pageDocument } from '../../prerender/document';
import BootSplash, { BootSplashHandoff } from './BootSplash';

const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');

/** The static splash as index.html ships it. */
const staticSplash = (): HTMLElement => {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const splash = parsed.getElementById(STATIC_BOOT_SPLASH_ID);
  if (splash === null) throw new Error('no static splash');
  return splash;
};

/** Each rect of an svg as its attribute string, in order. */
const rects = (svg: Element): string[] =>
  Array.from(svg.querySelectorAll('rect')).map((rect) =>
    ['x', 'y', 'width', 'height', 'rx']
      .map((name) => rect.getAttribute(name))
      .join(',')
  );

afterEach(() => {
  document.body.innerHTML = '';
});

describe('BootSplash', () => {
  it('announces itself as loading with the label given', () => {
    render(<BootSplash label="Loading workspace" />);
    expect(
      screen.getByRole('status', { name: 'Loading workspace' })
    ).toHaveClass('boot-splash');
  });

  it('draws the same mark and spinner as the static copy', () => {
    render(<BootSplash />);
    const rendered = screen.getByTestId('boot-splash');
    const shipped = staticSplash();
    const renderedMark = rendered.querySelector('svg.boot-splash-mark');
    const shippedMark = shipped.querySelector('svg.boot-splash-mark');
    if (renderedMark === null || shippedMark === null) {
      throw new Error('missing mark');
    }
    expect(rects(renderedMark)).toEqual(rects(shippedMark));
    expect(shippedMark.getAttribute('viewBox')).toBe(
      renderedMark.getAttribute('viewBox')
    );
    for (const mark of [renderedMark, shippedMark]) {
      expect(mark.getAttribute('width')).toBe(String(BOOT_SPLASH_MARK_SIZE));
      expect(mark.getAttribute('aria-hidden')).toBe('true');
    }
    expect(rendered.querySelector('.boot-splash-spinner')).not.toBeNull();
    expect(shipped.querySelector('.boot-splash-spinner')).not.toBeNull();
  });

  it('turns the spinner at the period index.html uses', () => {
    expect(html).toContain(
      `animation: boot-splash-spin ${BOOT_SPLASH_PERIOD_MS}ms linear infinite`
    );
    expect(html).toContain(
      `Math.round(performance.now() % ${BOOT_SPLASH_PERIOD_MS})`
    );
  });

  it('sets the spinner phase from the page clock', () => {
    expect(bootSplashPhase(BOOT_SPLASH_PERIOD_MS * 3 + 250)).toBe('-250ms');
    render(<BootSplash />);
    expect(
      screen.getByTestId('boot-splash').style.getPropertyValue('--boot-phase')
    ).toMatch(/^-\d+ms$/);
  });
});

describe('BootSplashHandoff', () => {
  it('removes the static splash when the app first renders', () => {
    const shipped = document.createElement('div');
    shipped.id = STATIC_BOOT_SPLASH_ID;
    document.body.appendChild(shipped);
    render(<BootSplashHandoff />);
    expect(document.getElementById(STATIC_BOOT_SPLASH_ID)).toBeNull();
  });
});

describe('the static splash in index.html', () => {
  it('sits after the root, hidden without JavaScript', () => {
    expect(html.indexOf('<div id="root"></div>')).toBeLessThan(
      html.indexOf(`id="${STATIC_BOOT_SPLASH_ID}"`)
    );
    expect(html).toMatch(/<noscript>\s*<style>\s*#boot-splash/);
  });

  it('leaves the root free for the prerendered pages', () => {
    const page = pageDocument(
      html,
      { path: '/pricing', title: 'Pricing', description: 'Plans' },
      '<h1>Pricing</h1>'
    );
    expect(page).toContain(
      '<div id="root"><div data-prerendered><h1>Pricing</h1></div></div>'
    );
    expect(page).toContain(`id="${STATIC_BOOT_SPLASH_ID}"`);
  });
});
