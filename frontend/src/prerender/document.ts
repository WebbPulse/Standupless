/**
 * Turns the built app shell into the static documents a crawler reads: one
 * HTML file per public page with its own title and description, plus
 * `robots.txt` and `sitemap.xml`. Pure string work, so the tests cover it
 * without a build.
 */

import { LAST_WORKSPACE_STORAGE_KEY } from '../lib/lastWorkspace';
import { LANDING_PARAM } from '../lib/paths';
import {
  SIGNED_IN_HINT_STORAGE_KEY,
  SIGNED_IN_HINT_VALUE,
} from '../lib/signedInHint';

/** The production site, which canonical links always name. */
export const PRODUCTION_ORIGIN = 'https://standupless.dev';

/** Paths a crawler is kept out of on production: the app behind sign in. */
export const DISALLOWED_PATHS = [
  '/w/',
  '/shared/',
  '/invites/',
  '/admin/',
  '/workspaces',
  '/security',
  '/reset-password',
  '/verify-email',
];

/** What one prerendered page puts in the document head. */
export interface PageMeta {
  path: string;
  title: string;
  description: string;
}

/** One file the build writes, relative to the output directory. */
export interface SiteFile {
  fileName: string;
  contents: string;
}

/**
 * The public origin a build serves, derived from its API origin by dropping
 * the leading `api.` label, so the staging build names the staging site. A
 * build with no API origin, or one that does not follow that shape, is taken
 * to be production.
 */
export const siteOrigin = (apiUrl: string | undefined): string => {
  const trimmed = apiUrl?.trim() ?? '';
  if (trimmed === '') return PRODUCTION_ORIGIN;
  try {
    const url = new URL(
      /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
    );
    if (!url.hostname.startsWith('api.')) return PRODUCTION_ORIGIN;
    return `https://${url.hostname.slice('api.'.length)}`;
  } catch {
    return PRODUCTION_ORIGIN;
  }
};

/** Escapes text for an HTML attribute or element body. */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** The file a page's document is written to: `index.html` or `<path>/index.html`. */
export const pageFileName = (path: string): string =>
  path === '/' ? 'index.html' : `${path.replace(/^\/+|\/+$/g, '')}/index.html`;

/**
 * Hides the prerendered page when the shell is served for some other path.
 * The root document doubles as the fallback for every app route, so a deep
 * link would otherwise show the home page until the app mounts.
 */
const staleGuard = (path: string): string =>
  `<style>html[data-prerender=stale] [data-prerendered]{display:none}</style>` +
  `<script>try{var p=location.pathname.replace(/\\/+$/,'')||'/';` +
  `if(p!==${JSON.stringify(path)})document.documentElement.dataset.prerender='stale'}catch(e){}</script>`;

/**
 * Sends a signed in visitor at the home page straight on to the workspace they
 * last opened, before the landing page paints. It reads only the non-secret
 * signed in marker and the last workspace slug, runs on `/` alone since the
 * root document doubles as the fallback for app routes, and leaves `?landing`
 * on the landing page.
 */
export const resumeRedirectScript = (): string =>
  `<script>try{if(location.pathname==='/'&&` +
  `!new URLSearchParams(location.search).has(${JSON.stringify(LANDING_PARAM)})&&` +
  `localStorage.getItem(${JSON.stringify(SIGNED_IN_HINT_STORAGE_KEY)})===${JSON.stringify(SIGNED_IN_HINT_VALUE)}){` +
  `var s=localStorage.getItem(${JSON.stringify(LAST_WORKSPACE_STORAGE_KEY)});` +
  `if(s)location.replace('/w/'+encodeURIComponent(s))}}catch(e){}</script>`;

/** Replaces the content of every `<meta {attribute}="{key}">` tag. */
const setMeta = (
  html: string,
  attribute: 'name' | 'property',
  key: string,
  value: string
): string =>
  html.replace(
    new RegExp(`(<meta\\s+${attribute}="${key}"\\s+content=")[^"]*(")`, 'g'),
    (_match, open: string, close: string) =>
      `${open}${escapeHtml(value)}${close}`
  );

/**
 * Fills the app shell for one page: its title, description, canonical and
 * social tags, the stale guard, the home page's resume redirect, and the
 * rendered markup inside `#root`. The no JavaScript notice goes, since the
 * page now reads without it. Every replacement is a function, so a `$` in a
 * price is never read as a pattern.
 */
export const pageDocument = (
  template: string,
  page: PageMeta,
  body: string
): string => {
  const url = `${PRODUCTION_ORIGIN}${page.path}`;
  let html = template.replace(
    /<title>[^<]*<\/title>/,
    () => `<title>${escapeHtml(page.title)}</title>`
  );
  html = setMeta(html, 'name', 'description', page.description);
  html = setMeta(html, 'property', 'og:title', page.title);
  html = setMeta(html, 'property', 'og:description', page.description);
  html = setMeta(html, 'property', 'og:url', url);
  html = setMeta(html, 'name', 'twitter:title', page.title);
  html = setMeta(html, 'name', 'twitter:description', page.description);
  html = html.replace(
    /(<link\s+rel="canonical"\s+href=")[^"]*(")/,
    (_match, open: string, close: string) => `${open}${url}${close}`
  );
  if (page.path === '/') {
    html = html.replace(
      /<head(\s[^>]*)?>/,
      (open) => `${open}${resumeRedirectScript()}`
    );
  }
  html = html.replace('</head>', () => `${staleGuard(page.path)}</head>`);
  html = html.replace(/\s*<noscript>[\s\S]*?<\/noscript>/, '');
  return html.replace(
    '<div id="root"></div>',
    () => `<div id="root"><div data-prerendered>${body}</div></div>`
  );
};

/**
 * The crawler rules for a site. Anything but production is closed to every
 * crawler, so a staging page never competes with the real one.
 */
export const robotsTxt = (origin: string): string => {
  if (origin !== PRODUCTION_ORIGIN) {
    return 'User-agent: *\nDisallow: /\n';
  }
  const rules = DISALLOWED_PATHS.map((path) => `Disallow: ${path}`).join('\n');
  return `User-agent: *\nAllow: /\n${rules}\n\nSitemap: ${origin}/sitemap.xml\n`;
};

/** A sitemap listing every prerendered page under the site's origin. */
export const sitemapXml = (origin: string, paths: string[]): string => {
  const urls = paths
    .map((path) => `  <url><loc>${escapeHtml(`${origin}${path}`)}</loc></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
};
