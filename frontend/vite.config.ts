/**
 * Vite build configuration. Every dependency lands in one `vendor` chunk except
 * the emoji dataset, which the reaction picker imports on first open and so
 * stays a chunk of its own rather than weighing down every page load.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig, type Plugin } from 'vite';

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

export default defineConfig({
  plugins: [react(), tailwindcss(), openapiDocument()],
  server: {
    port: 4000,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    allowedHosts: ['standupless.dev', 'staging.standupless.dev'],
  },
  build: {
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('emojibase-data')) {
            return undefined;
          }
          if (id.includes('node_modules')) {
            return 'vendor';
          }
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
