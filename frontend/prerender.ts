/**
 * Build step that writes the public pages as static HTML. After the client
 * bundle is written, it builds `src/prerender/entry.tsx` for Node, renders
 * each public page into the built shell and writes the result beside it, with
 * `robots.txt` and `sitemap.xml`. The app still mounts over the markup, so
 * every route keeps working as a single page app.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react-swc';
import { build, loadEnv, type Plugin, type ResolvedConfig } from 'vite';

/** The server entry, relative to the project root. */
const ENTRY = 'src/prerender/entry.tsx';

/**
 * Where the server build goes, inside the project so its bare imports resolve
 * against the project's own `node_modules`.
 */
const SCRATCH = 'node_modules/.tmp/prerender';

/** What the server entry exports to this step. */
interface PrerenderEntry {
  buildSite: (
    template: string,
    apiUrl: string | undefined
  ) => { fileName: string; contents: string }[];
}

/** Builds the server entry into a scratch directory and loads it. */
const loadEntry = async (
  config: ResolvedConfig,
  outDir: string
): Promise<PrerenderEntry> => {
  await build({
    configFile: false,
    root: config.root,
    mode: config.mode,
    logLevel: 'warn',
    plugins: [react()],
    build: {
      ssr: ENTRY,
      outDir,
      emptyOutDir: true,
      rollupOptions: { output: { entryFileNames: 'entry.mjs' } },
    },
  });
  return (await import(
    pathToFileURL(join(outDir, 'entry.mjs')).href
  )) as PrerenderEntry;
};

/** The Vite plugin that prerenders the public pages at build time. */
export const prerender = (): Plugin => {
  let config: ResolvedConfig | undefined;
  return {
    name: 'standupless-prerender',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    async closeBundle() {
      if (config === undefined || config.build.ssr !== false) return;
      const outDir = resolve(config.root, config.build.outDir);
      const scratch = resolve(config.root, SCRATCH);
      try {
        const entry = await loadEntry(config, scratch);
        const env = loadEnv(config.mode, config.envDir || config.root, 'VITE_');
        const template = await readFile(join(outDir, 'index.html'), 'utf8');
        for (const file of entry.buildSite(template, env.VITE_API_URL)) {
          const target = join(outDir, file.fileName);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.contents);
        }
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  };
};
