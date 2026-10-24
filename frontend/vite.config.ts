/**
 * Vite build configuration. Every dependency lands in one `vendor` chunk except
 * three that load on demand: the emoji dataset, which the reaction picker
 * imports on first open, the rich text editor, which loads when a description
 * is shown, and the syntax highlighter, which loads with the first code block. Each stays a chunk of its own rather than weighing down every page.
 * After the bundle is written, the public pages are prerendered to static HTML.
 * The dev server proxies `/api` to the backend `VITE_BACKEND` names.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { apiProxy, devWatch } from './devProxy.ts';
import { prerender } from './prerender.ts';

/** The merged OpenAPI document the backend commits and its tests keep current. */
const OPENAPI_SOURCE = fileURLToPath(
  new URL('../backend/openapi.json', import.meta.url)
);

/** Where the document is published on the site's own origin. */
const OPENAPI_PATH = 'openapi.json';

/**
 * Publishes the committed OpenAPI document beside the app.
 *
 * Each deployed function serves only its own slice of the API, so no live route
 * holds the whole surface. The committed file is the merged spec, and a backend
 * test fails when it drifts, so shipping it as a static asset gives the public
 * one current document with no extra infrastructure.
 */
const openapiDocument = (): Plugin => ({
  name: 'standupless-openapi-document',
  configureServer(server) {
    server.middlewares.use(`/${OPENAPI_PATH}`, (_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(readFileSync(OPENAPI_SOURCE));
    });
  },
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: OPENAPI_PATH,
      source: readFileSync(OPENAPI_SOURCE),
    });
  },
});

/**
 * The app id of the mobile app the deployed environment links to. Staging's
 * app installs beside production's under its own id.
 */
const DEFAULT_MOBILE_APP_ID = 'dev.standupless.app';

/** The site paths the mobile apps open instead of the browser. */
const MOBILE_LINK_PATH = '/w/*/issues/*';

/** Reads one build variable, treating blank as unset. */
const buildVariable = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
};

/**
 * Builds the Apple app site association document, which lets the iOS app open
 * issue links as universal links and share passkeys and saved passwords with
 * the site. Returns null until the Apple team id is known.
 */
const appleAppSiteAssociation = (
  teamId: string | undefined,
  appId: string
): string | null => {
  if (teamId === undefined) return null;
  if (!/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error(`STANDUPLESS_APPLE_TEAM_ID is not a team id: ${teamId}`);
  }
  const app = `${teamId}.${appId}`;
  return `${JSON.stringify(
    {
      applinks: {
        details: [{ appIDs: [app], components: [{ '/': MOBILE_LINK_PATH }] }],
      },
      webcredentials: { apps: [app] },
    },
    null,
    2
  )}\n`;
};

/**
 * Builds the Digital Asset Links document, which verifies the Android app's
 * App Links for issue pages and shares saved credentials and passkeys with
 * the site. Returns null until a signing certificate fingerprint is known.
 */
const assetLinks = (
  fingerprints: string | undefined,
  appId: string
): string | null => {
  if (fingerprints === undefined) return null;
  const list = fingerprints
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry !== '');
  for (const entry of list) {
    if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(entry)) {
      throw new Error(
        `STANDUPLESS_ANDROID_CERT_SHA256 holds a value that is not a SHA-256 fingerprint: ${entry}`
      );
    }
  }
  if (list.length === 0) return null;
  return `${JSON.stringify(
    [
      {
        relation: [
          'delegate_permission/common.handle_all_urls',
          'delegate_permission/common.get_login_creds',
        ],
        target: {
          namespace: 'android_app',
          package_name: appId,
          sha256_cert_fingerprints: list,
        },
      },
    ],
    null,
    2
  )}\n`;
};

/**
 * Publishes the mobile app association documents under `/.well-known/`. Each
 * one is written only when its identifiers are set for the environment, so a
 * build never claims an app the stores do not hold yet.
 */
const mobileAssociations = (): Plugin => ({
  name: 'standupless-mobile-associations',
  generateBundle() {
    const appId =
      buildVariable('STANDUPLESS_MOBILE_APP_ID') ?? DEFAULT_MOBILE_APP_ID;
    const apple = appleAppSiteAssociation(
      buildVariable('STANDUPLESS_APPLE_TEAM_ID'),
      appId
    );
    if (apple !== null) {
      this.emitFile({
        type: 'asset',
        fileName: '.well-known/apple-app-site-association',
        source: apple,
      });
    }
    const android = assetLinks(
      buildVariable('STANDUPLESS_ANDROID_CERT_SHA256'),
      appId
    );
    if (android !== null) {
      this.emitFile({
        type: 'asset',
        fileName: '.well-known/assetlinks.json',
        source: android,
      });
    }
  },
});

/**
 * The rich text editor's dependencies. They go in their own chunk, loaded only
 * when a description is shown, so the vendor chunk every page loads stays lean.
 * The vendor group is captured first so shared dependencies such as React stay
 * in vendor rather than being pulled into the editor chunk.
 */
const EDITOR_MODULES =
  /node_modules[\\/](@tiptap|prosemirror-[^\\/]+|marked|linkifyjs|orderedmap|rope-sequence|w3c-keyname|@floating-ui|fast-equals|use-sync-external-store)[\\/]/;

/**
 * The syntax highlighter and its languages. They load on demand the first time
 * a code block is shown, so they stay out of both the vendor chunk and the
 * editor chunk and land in the lazy chunk that imports them.
 */
const HIGHLIGHT_MODULES =
  /node_modules[\\/](lowlight|highlight\.js|devlop)[\\/]/;

/**
 * The highlighter's core, which the editor's code block and the language chunk
 * both import. It is a small chunk of its own so neither carries a copy.
 */
const HIGHLIGHT_CORE = /node_modules[\\/]highlight\.js[\\/]lib[\\/]core\.js$/;

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const watch = devWatch(env);
  return {
    plugins: [
      react(),
      tailwindcss(),
      openapiDocument(),
      mobileAssociations(),
      prerender(),
    ],
    server: {
      port: 4000,
      proxy: apiProxy(env),
      ...(watch === undefined ? {} : { watch }),
    },
    preview: {
      allowedHosts: ['standupless.dev', 'staging.standupless.dev'],
    },
    build: {
      sourcemap: 'hidden',
      rollupOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: 'vendor',
                test: (id: string) =>
                  id.includes('node_modules') &&
                  !id.includes('emojibase-data') &&
                  !EDITOR_MODULES.test(id) &&
                  !HIGHLIGHT_MODULES.test(id),
                priority: 2,
              },
              {
                name: 'editor',
                test: EDITOR_MODULES,
                priority: 1,
              },
              {
                name: 'highlight-core',
                test: HIGHLIGHT_CORE,
                priority: 3,
              },
            ],
          },
        },
      },
      chunkSizeWarningLimit: 600,
    },
  };
});
