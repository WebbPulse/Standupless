/**
 * The server side entry the build renders the public pages through. Each page
 * renders inside the real auth provider, whose first render is the unsettled
 * session, so the markup is the signed out page without the marker the browser
 * suite waits on after a sign out.
 */

import React from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { AuthProvider } from '../contexts/AuthContext';
import {
  CONTACT_PATH,
  PRICING_PATH,
  PRIVACY_PATH,
  REFUNDS_PATH,
  TERMS_PATH,
} from '../lib/paths';
import Contact, { CONTACT_TITLE } from '../pages/contact/Contact';
import {
  LandingContent,
  LANDING_DESCRIPTION,
  LANDING_TITLE,
} from '../pages/landing/Landing';
import Privacy from '../pages/legal/Privacy';
import Refunds from '../pages/legal/Refunds';
import Terms from '../pages/legal/Terms';
import Pricing, {
  PRICING_DESCRIPTION,
  PRICING_TITLE,
} from '../pages/pricing/Pricing';
import {
  pageDocument,
  pageFileName,
  robotsTxt,
  siteOrigin,
  sitemapXml,
  type PageMeta,
  type SiteFile,
} from './document';

/** A public page the build writes as static HTML. */
interface PrerenderedPage extends PageMeta {
  element: React.ReactElement;
}

/** Every page a crawler can read without running the app. */
export const PRERENDERED_PAGES: PrerenderedPage[] = [
  {
    path: '/',
    title: LANDING_TITLE,
    description: LANDING_DESCRIPTION,
    element: <LandingContent />,
  },
  {
    path: PRICING_PATH,
    title: PRICING_TITLE,
    description: PRICING_DESCRIPTION,
    element: <Pricing />,
  },
  {
    path: TERMS_PATH,
    title: 'Terms of Service | Standupless',
    description:
      'The Standupless Terms of Service: accounts, acceptable use, paid plans, payment and cancellation.',
    element: <Terms />,
  },
  {
    path: PRIVACY_PATH,
    title: 'Privacy Policy | Standupless',
    description:
      'What Standupless collects, why, where it is kept, who processes it and how to have it deleted.',
    element: <Privacy />,
  },
  {
    path: REFUNDS_PATH,
    title: 'Cancellation and Refund Policy | Standupless',
    description:
      'Cancel a Standupless plan anytime from the billing portal and keep access until the end of the paid period. Payments are not refunded.',
    element: <Refunds />,
  },
  {
    path: CONTACT_PATH,
    title: CONTACT_TITLE,
    description:
      'Contact Standupless about support, billing, privacy or security by email.',
    element: <Contact />,
  },
];

/** Renders one page's markup as the browser would first paint it. */
export const renderPage = (page: PrerenderedPage): string =>
  renderToString(
    <StaticRouter location={page.path}>
      <AuthProvider>{page.element}</AuthProvider>
    </StaticRouter>
  );

/**
 * Every static file for a build: a document per page from the built shell,
 * plus the crawler rules and the sitemap for the site the build serves.
 */
export const buildSite = (
  template: string,
  apiUrl: string | undefined
): SiteFile[] => {
  const origin = siteOrigin(apiUrl);
  const location = globalThis.location as Location | undefined;
  if (location === undefined) {
    Object.defineProperty(globalThis, 'location', {
      value: new URL(`${origin}/`),
      configurable: true,
    });
  }
  try {
    return [
      ...PRERENDERED_PAGES.map((page) => ({
        fileName: pageFileName(page.path),
        contents: pageDocument(template, page, renderPage(page)),
      })),
      { fileName: 'robots.txt', contents: robotsTxt(origin) },
      {
        fileName: 'sitemap.xml',
        contents: sitemapXml(
          origin,
          PRERENDERED_PAGES.map((page) => page.path)
        ),
      },
    ];
  } finally {
    if (location === undefined) {
      Reflect.deleteProperty(globalThis, 'location');
    }
  }
};
