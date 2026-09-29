/**
 * The prerendered site: every public page is written with its own copy, the
 * pricing page carries every price, and no page carries the signed out marker
 * the browser suite waits on after a sign out.
 */

import { describe, expect, it } from 'vitest';
import { buildSite } from './entry';

const TEMPLATE =
  '<html><head><title>Standupless</title></head><body><div id="root"></div></body></html>';

const files = buildSite(TEMPLATE, 'https://api.standupless.dev');
const file = (name: string): string =>
  files.find((entry) => entry.fileName === name)?.contents ?? '';

describe('buildSite', () => {
  it('writes each public page, the crawler rules and the sitemap', () => {
    expect(files.map((entry) => entry.fileName)).toEqual([
      'index.html',
      'pricing/index.html',
      'terms/index.html',
      'privacy/index.html',
      'refunds/index.html',
      'contact/index.html',
      'robots.txt',
      'sitemap.xml',
    ]);
  });

  it('prints every plan and both prices on the pricing page', () => {
    const pricing = file('pricing/index.html');
    expect(pricing).toContain('<title>Pricing | Standupless</title>');
    for (const text of [
      'Free',
      'Standard',
      'Business',
      '$0',
      '$6',
      '$8',
      '$10',
      '$12',
    ]) {
      expect(pricing).toContain(text);
    }
  });

  it('renders the policy, contact and home pages', () => {
    expect(file('refunds/index.html')).toContain(
      'Cancellation and Refund Policy'
    );
    expect(file('contact/index.html')).toContain('tyler@webbpulse.com');
    expect(file('terms/index.html')).toContain('Terms of Service');
    expect(file('privacy/index.html')).toContain('Privacy Policy');
    expect(file('index.html')).toContain(
      'Issues, cycles and projects for software teams'
    );
  });

  it('leaves the signed out marker off every page', () => {
    for (const entry of files) {
      expect(entry.contents).not.toContain('signed-out');
    }
  });

  it('opens production to crawlers', () => {
    expect(file('robots.txt')).toContain(
      'Sitemap: https://standupless.dev/sitemap.xml'
    );
  });
});
