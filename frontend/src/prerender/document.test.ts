/**
 * The static document helpers: the site origin a build derives from its API
 * origin, the per page head and body, and the crawler files.
 */

import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  pageDocument,
  pageFileName,
  PRODUCTION_ORIGIN,
  resumeRedirectScript,
  robotsTxt,
  siteOrigin,
  sitemapXml,
} from './document';

const TEMPLATE = `<!doctype html>
<html>
  <head>
    <title>Standupless</title>
    <meta
      name="description"
      content="Old description."
    />
    <link rel="canonical" href="https://standupless.dev/" />
    <meta property="og:title" content="Standupless" />
    <meta property="og:description" content="Old." />
    <meta property="og:url" content="https://standupless.dev/" />
    <meta name="twitter:title" content="Standupless" />
    <meta name="twitter:description" content="Old." />
  </head>
  <body>
    <div id="root"></div>
    <noscript><p>Standupless requires JavaScript.</p></noscript>
  </body>
</html>`;

describe('siteOrigin', () => {
  it('drops the api label from the API origin', () => {
    expect(siteOrigin('https://api.staging.standupless.dev')).toBe(
      'https://staging.standupless.dev'
    );
    expect(siteOrigin('api.standupless.dev')).toBe(PRODUCTION_ORIGIN);
  });

  it('falls back to production for anything else', () => {
    expect(siteOrigin(undefined)).toBe(PRODUCTION_ORIGIN);
    expect(siteOrigin(' ')).toBe(PRODUCTION_ORIGIN);
    expect(siteOrigin('http://localhost:8000')).toBe(PRODUCTION_ORIGIN);
  });
});

describe('pageFileName', () => {
  it('writes the root to index.html and every other page to its folder', () => {
    expect(pageFileName('/')).toBe('index.html');
    expect(pageFileName('/pricing')).toBe('pricing/index.html');
  });
});

describe('pageDocument', () => {
  const html = pageDocument(
    TEMPLATE,
    {
      path: '/pricing',
      title: 'Pricing | Standupless',
      description: 'Standard at $6 or $8, Business at $10 or $12.',
    },
    '<h1>Pricing $1 $&amp;</h1>'
  );

  it('sets the head for the page, keeping every dollar sign as written', () => {
    expect(html).toContain('<title>Pricing | Standupless</title>');
    expect(html).toContain(
      'content="Standard at $6 or $8, Business at $10 or $12."'
    );
    expect(html).toContain('href="https://standupless.dev/pricing"');
    expect(html).toContain(
      '<meta property="og:url" content="https://standupless.dev/pricing" />'
    );
    expect(html).toContain(
      '<meta name="twitter:title" content="Pricing | Standupless" />'
    );
    expect(html).not.toContain('Old');
  });

  it('puts the markup in the root and drops the no JavaScript notice', () => {
    expect(html).toContain(
      '<div id="root"><div data-prerendered><h1>Pricing $1 $&amp;</h1></div></div>'
    );
    expect(html).not.toContain('<noscript>');
  });

  it('hides the page when the shell is served for another path', () => {
    expect(html).toContain('[data-prerendered]{display:none}');
    expect(html).toContain('if(p!=="/pricing")');
  });
});

describe('resume redirect', () => {
  const run = (url: string, held: Record<string, string>): string | null => {
    const { pathname, search } = new URL(url, PRODUCTION_ORIGIN);
    let target: string | null = null;
    const location = {
      pathname,
      search,
      replace: (to: string) => {
        target = to;
      },
    };
    const localStorage = {
      getItem: (key: string) =>
        new Map(Object.entries(held)).get(key) ?? null,
    };
    const body = resumeRedirectScript().replace(/^<script>|<\/script>$/g, '');
    runInNewContext(body, { location, localStorage, URLSearchParams });
    return target;
  };
  const signedIn = {
    'standupless-signed-in': '1',
    'standupless-last-workspace': 'acme co',
  };

  it('sends a signed in visitor at the root to the last workspace', () => {
    expect(run('/', signedIn)).toBe('/w/acme%20co');
  });

  it('leaves signed out visitors and crawlers on the landing page', () => {
    expect(run('/', {})).toBeNull();
    expect(run('/', { 'standupless-last-workspace': 'acme co' })).toBeNull();
  });

  it('needs a last workspace to resume', () => {
    expect(run('/', { 'standupless-signed-in': '1' })).toBeNull();
  });

  it('keeps the landing page open with the escape hatch', () => {
    expect(run('/?landing', signedIn)).toBeNull();
  });

  it('only fires on the root, which also serves app routes', () => {
    expect(run('/w/acme/issues', signedIn)).toBeNull();
    expect(run('/pricing', signedIn)).toBeNull();
  });

  it('is added to the root document only, first in the head', () => {
    const root = pageDocument(
      TEMPLATE,
      { path: '/', title: 'Standupless', description: 'Home.' },
      '<h1>Home</h1>'
    );
    const pricing = pageDocument(
      TEMPLATE,
      { path: '/pricing', title: 'Pricing', description: 'Prices.' },
      '<h1>Pricing</h1>'
    );

    expect(root).toContain(`<head>${resumeRedirectScript()}`);
    expect(pricing).not.toContain('location.replace');
  });
});

describe('crawler files', () => {
  it('opens production to crawlers apart from the app and names the sitemap', () => {
    const robots = robotsTxt(PRODUCTION_ORIGIN);
    expect(robots).toContain('Allow: /\n');
    expect(robots).toContain('Disallow: /w/\n');
    expect(robots).toContain('Sitemap: https://standupless.dev/sitemap.xml');
  });

  it('closes every other site to crawlers', () => {
    expect(robotsTxt('https://staging.standupless.dev')).toBe(
      'User-agent: *\nDisallow: /\n'
    );
  });

  it('lists each page under the origin', () => {
    const sitemap = sitemapXml(PRODUCTION_ORIGIN, ['/', '/pricing']);
    expect(sitemap).toContain('<loc>https://standupless.dev/</loc>');
    expect(sitemap).toContain('<loc>https://standupless.dev/pricing</loc>');
  });
});
