/**
 * Build check that the frontend Content-Security-Policy script hashes in
 * terraform/cloudfront.tf match the inline scripts the build ships. It hashes
 * every inline script in every HTML document under `dist`, reads the
 * `frontend_inline_script_hashes` list, and fails when a built script is
 * missing from the list or the list holds a hash no document uses.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

/** The built site, as `npm run build` writes it. */
const DIST = resolve(import.meta.dirname, 'dist');

/** The Terraform file that holds the hash list. */
const TERRAFORM = resolve(import.meta.dirname, '../terraform/cloudfront.tf');

/** Every HTML file under a directory, as absolute paths. */
const htmlFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => join(entry.parentPath, entry.name));
};

/** The CSP source for a script body: its SHA-256 in base64. */
export const scriptHash = (body: string): string =>
  `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`;

/** The bodies of the inline scripts in a document, skipping any with `src`. */
export const inlineScripts = (html: string): string[] =>
  Array.from(
    html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g),
    (match) => match[1] ?? ''
  );

/** The hashes in the `frontend_inline_script_hashes` list of a Terraform file. */
export const terraformHashes = (terraform: string): string[] => {
  const list = /frontend_inline_script_hashes\s*=\s*\[([\s\S]*?)\]/.exec(
    terraform
  );
  if (list === null) {
    throw new Error('frontend_inline_script_hashes was not found');
  }
  return Array.from(
    (list[1] ?? '').matchAll(/'(sha256-[A-Za-z0-9+/=]+)'/g),
    (match) => match[1] ?? ''
  );
};

/** Compares the built hashes with the Terraform list and exits non-zero on drift. */
const main = async (): Promise<void> => {
  const built = new Map<string, string[]>();
  for (const file of await htmlFiles(DIST)) {
    const html = await readFile(file, 'utf8');
    for (const body of inlineScripts(html)) {
      const hash = scriptHash(body);
      built.set(hash, [...(built.get(hash) ?? []), relative(DIST, file)]);
    }
  }
  if (built.size === 0) {
    throw new Error(`no inline scripts were found under ${DIST}`);
  }
  const listed = new Set(terraformHashes(await readFile(TERRAFORM, 'utf8')));
  const missing = [...built.keys()].filter((hash) => !listed.has(hash));
  const unused = [...listed].filter((hash) => !built.has(hash));
  for (const hash of missing) {
    console.error(
      `Missing from frontend_inline_script_hashes: '${hash}' (${(built.get(hash) ?? []).join(', ')})`
    );
  }
  for (const hash of unused) {
    console.error(
      `Unused in frontend_inline_script_hashes: '${hash}' matches no built inline script`
    );
  }
  if (missing.length > 0 || unused.length > 0) {
    console.error(
      'Update frontend_inline_script_hashes in terraform/cloudfront.tf to the built hashes.'
    );
    process.exit(1);
  }
  console.log(
    `frontend_inline_script_hashes matches the ${built.size} inline scripts the build ships.`
  );
};

await main();
