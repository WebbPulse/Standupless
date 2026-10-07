/**
 * Every clickable element shows that it is clickable.
 *
 * This walks the source rather than rendering, because the failure it defends
 * against is a new link or button that ships with no hover state, and that is
 * a property of the class list written next to it. An element passes when its
 * class list, after following the constants it names in this file or in a
 * relative import, carries a `hover:` variant or one of the shared
 * `interactive-*` utilities. A stretched link or toggle whose hover lives on
 * the row around it says so with `data-hover="parent"`, and the guard then
 * checks that an enclosing element in the same file does carry one. Native
 * inputs take their hover and press from the base layer instead, which the
 * second block checks.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

const INTERACTIVE_TAGS = new Set(['button', 'a', 'summary', 'Link', 'NavLink']);

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'radio',
  'checkbox',
  'treeitem',
]);

const HOVER = /(^|[\s:'"`])(hover:|group-hover|interactive-)/;

/** Every component source file, leaving out tests. */
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

const parsed = new Map<string, ts.SourceFile>();

/** The parsed module at a path, cached. */
const parse = (path: string): ts.SourceFile => {
  const held = parsed.get(path);
  if (held !== undefined) return held;
  const file = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  parsed.set(path, file);
  return file;
};

/** The file a relative import specifier points at, if it is one. */
const resolveImport = (from: string, specifier: string): string | null => {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
};

/** The initialisers of every variable called `name` in a file. */
const declarationsOf = (file: ts.SourceFile, name: string): ts.Node[] => {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      found.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
};

/** Where an imported binding called `name` comes from, if it is relative. */
const importSource = (file: ts.SourceFile, name: string): string | null => {
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    if (!bindings.elements.some((element) => element.name.text === name)) {
      continue;
    }
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) return null;
    return resolveImport(file.fileName, specifier.text);
  }
  return null;
};

/** All the class text an expression can produce, following named constants. */
const classText = (
  node: ts.Node,
  file: ts.SourceFile,
  seen: Set<string> = new Set()
): string => {
  const parts: string[] = [];
  const visit = (current: ts.Node): void => {
    if (
      ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current)
    ) {
      parts.push(current.text);
      return;
    }
    if (ts.isTemplateHead(current) || ts.isTemplateMiddle(current)) {
      parts.push(current.text);
    }
    if (ts.isTemplateTail(current)) parts.push(current.text);
    if (ts.isIdentifier(current)) {
      const key = `${file.fileName}#${current.text}`;
      if (seen.has(key)) return;
      seen.add(key);
      for (const init of declarationsOf(file, current.text)) {
        parts.push(classText(init, file, seen));
      }
      const source = importSource(file, current.text);
      if (source !== null) {
        const target = parse(source);
        for (const init of declarationsOf(target, current.text)) {
          parts.push(classText(init, target, seen));
        }
      }
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return parts.join(' ');
};

/** The attributes on a JSX element, by name. */
const attributesOf = (
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement
): Map<string, ts.JsxAttribute> => {
  const map = new Map<string, ts.JsxAttribute>();
  for (const property of element.attributes.properties) {
    if (ts.isJsxAttribute(property)) {
      map.set(property.name.getText(), property);
    }
  }
  return map;
};

/** The literal text of an attribute, or null when it is computed. */
const literal = (attribute: ts.JsxAttribute | undefined): string | null => {
  const init = attribute?.initializer;
  if (init === undefined) return null;
  if (ts.isStringLiteral(init)) return init.text;
  if (
    ts.isJsxExpression(init) &&
    init.expression !== undefined &&
    ts.isStringLiteral(init.expression)
  ) {
    return init.expression.text;
  }
  return null;
};

/** Whether an element's class list carries a hover treatment. */
const hovers = (
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  file: ts.SourceFile
): boolean => {
  const className = attributesOf(element).get('className')?.initializer;
  return (
    className !== undefined && HOVER.test(` ${classText(className, file)}`)
  );
};

/** Whether an enclosing element in the same file carries a hover treatment. */
const ancestorHovers = (node: ts.Node, file: ts.SourceFile): boolean => {
  for (let current = node.parent; current !== undefined;) {
    if (ts.isJsxElement(current) && hovers(current.openingElement, file)) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

/** Each clickable element in a file that shows no hover state. */
const offenders = (path: string): string[] => {
  const file = parse(path);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(file);
      const attributes = attributesOf(node);
      const role = literal(attributes.get('role'));
      const interactive =
        tag !== 'input' &&
        (INTERACTIVE_TAGS.has(tag) ||
          (/^[a-z]/.test(tag) && role !== null && INTERACTIVE_ROLES.has(role)));
      if (interactive) {
        const delegated = literal(attributes.get('data-hover')) === 'parent';
        const ok = delegated ? ancestorHovers(node, file) : hovers(node, file);
        if (!ok) {
          const { line } = file.getLineAndCharacterOfPosition(node.getStart());
          found.push(`${relative(SRC, path)}:${line + 1} <${tag}>`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
};

describe('clickable elements', () => {
  it('all carry a hover state, directly or through the row around them', () => {
    const found = sourceFiles(SRC)
      .filter((path) => path.endsWith('.tsx'))
      .flatMap(offenders);
    expect(found).toEqual([]);
  });
});

describe('the interactive utilities', () => {
  const css = readFileSync(join(SRC, 'index.css'), 'utf8');

  /** The body of one `@utility` block. */
  const utility = (name: string): string => {
    const start = css.indexOf(`@utility ${name} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let index = css.indexOf('{', start); index < css.length; index += 1) {
      if (css[index] === '{') depth += 1;
      if (css[index] === '}') depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
    return '';
  };

  it.each(['row', 'chip', 'card', 'link', 'quiet', 'host'])(
    'interactive-%s has a pointer, a short ease, a hover, a press and a focus state',
    (name) => {
      const body = utility(`interactive-${name}`);
      expect(body).toMatch(/cursor:\s*pointer/);
      expect(body).toMatch(/transition[^;]*1[0-5]0ms ease/);
      expect(body).toMatch(/&:hover/);
      expect(body).toMatch(/&:active/);
      expect(body).toMatch(/focus-visible/);
    }
  );

  it('derives the hover and press tints from the neutral text token', () => {
    expect(css).toMatch(/--color-hover:\s*color-mix\([^;]*var\(--text\)/);
    expect(css).toMatch(/--color-press:\s*color-mix\([^;]*var\(--text\)/);
  });

  it('gives native checkboxes and switches a hover and a press', () => {
    expect(css).toMatch(/\[role='switch'\]\):hover/);
    expect(css).toMatch(/\[role='switch'\]\):active/);
    expect(css).toMatch(/\[role='switch'\]:hover/);
    expect(css).toMatch(/\[role='switch'\]:active/);
  });

  it('switches transitions off for reduced motion', () => {
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\)[\s\S]*transition-duration: 0\.01ms/
    );
  });
});
