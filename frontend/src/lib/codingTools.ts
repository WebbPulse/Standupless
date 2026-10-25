/**
 * Handing an issue to a coding tool on the person's own machine, as Linear's
 * "Open in coding tool" does. Everything is built here in the browser from the
 * issue's key, title, address, branch name and description through one fixed
 * template, so the same issue always gives the same prompt and no model and
 * no server is involved.
 *
 * A tool with a URL scheme that takes a prompt is opened through it. A tool
 * without one gets a ready-to-run terminal command on the clipboard instead,
 * which switches to the issue's branch, creating it when it is new, and
 * starts the tool with the prompt. Either way a toast says which happened.
 *
 * The default tool is kept in this browser rather than on the account,
 * because which tools are installed is a fact about the machine, not the
 * person.
 */

import { useSyncExternalStore } from 'react';
import { copyText } from './copyIssue';
import { showToast } from './toast';

/** The tools an issue can be opened in. */
export type CodingToolId = 'claude-code' | 'cursor' | 'vscode' | 'codex';

/** One tool and how an issue reaches it. */
export interface CodingTool {
  id: CodingToolId;
  /** The tool's name as menus and toasts show it. */
  name: string;
  /** Whether the tool opens through a URL scheme or a copied command. */
  kind: 'url' | 'command';
  /** What picking the tool does, in a few words. */
  detail: string;
}

/** Every supported tool, in the order the pickers list them. */
export const CODING_TOOLS: readonly CodingTool[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    kind: 'command',
    detail: 'Copies a terminal command',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    kind: 'url',
    detail: 'Opens the app',
  },
  {
    id: 'vscode',
    name: 'VS Code',
    kind: 'command',
    detail: 'Copies a terminal command',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    kind: 'command',
    detail: 'Copies a terminal command',
  },
];

/** The tool used until the person picks another. */
export const DEFAULT_CODING_TOOL: CodingToolId = 'claude-code';

/** The keys that open the issue in focus in the default tool. */
export const OPEN_IN_CODING_TOOL_KEYS = 'mod+alt+o';

/** The command that lists every tool to pick from, which has no keys. */
export const OPEN_IN_CODING_TOOL_LABEL = 'Open in coding tool';

/** Where this browser remembers the default tool. */
export const CODING_TOOL_STORAGE_KEY = 'standupless-coding-tool';

/** The longest deep link a tool is handed, below what the schemes accept. */
export const MAX_DEEP_LINK_LENGTH = 8000;

/** The line a description cut to fit a deep link ends on. */
const TRUNCATED_NOTE =
  '(Description shortened. Read the full issue at the link above.)';

/** The tool with the given id. */
export const codingTool = (id: CodingToolId): CodingTool =>
  CODING_TOOLS.find((tool) => tool.id === id) ?? {
    id,
    name: id,
    kind: 'command',
    detail: 'Copies a terminal command',
  };

/** Whether a stored value names a supported tool. */
const isToolId = (value: unknown): value is CodingToolId =>
  CODING_TOOLS.some((tool) => tool.id === value);

/** Everyone who wants to hear when the default tool changes. */
const listeners = new Set<() => void>();

/** The default tool this browser remembers, ignoring a storage that refuses. */
export const readDefaultCodingTool = (): CodingToolId => {
  try {
    const stored = globalThis.localStorage.getItem(CODING_TOOL_STORAGE_KEY);
    return isToolId(stored) ? stored : DEFAULT_CODING_TOOL;
  } catch {
    return DEFAULT_CODING_TOOL;
  }
};

/** Remembers the default tool in this browser and tells the subscribers. */
export const setDefaultCodingTool = (id: CodingToolId): void => {
  try {
    globalThis.localStorage.setItem(CODING_TOOL_STORAGE_KEY, id);
  } catch {
    return;
  }
  for (const listener of [...listeners]) listener();
};

/** Subscribes to default tool changes, returning the unsubscribe function. */
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Reads the default tool and re-renders whenever it changes. */
export const useDefaultCodingTool = (): CodingToolId =>
  useSyncExternalStore(subscribe, readDefaultCodingTool, readDefaultCodingTool);

/** What the prompt is built from. */
export interface CodingIssue {
  key: string;
  title: string;
  /** The issue's full address. */
  url: string;
  /** The git branch name in the workspace's format. */
  branch: string;
  /** The description as stored Markdown, or nothing. */
  body: string | null | undefined;
}

/**
 * The prompt for an issue, from the fixed template: the key and title, the
 * address and branch, then the description as Markdown. The same issue
 * always gives the same text.
 */
export const codingPrompt = (issue: CodingIssue): string => {
  const body = (issue.body ?? '').replace(/\s+$/, '');
  return [
    `Work on ${issue.key}: ${issue.title}`,
    `Issue: ${issue.url}\nBranch: ${issue.branch}`,
    `Use the branch ${issue.branch}, creating it if it does not exist yet.`,
    `## Description\n\n${body.trim() === '' ? 'No description.' : body}`,
  ].join('\n\n');
};

/** Quotes text for a POSIX shell, so any character in it reaches the tool as is. */
export const shellQuote = (text: string): string =>
  `'${text.replace(/'/g, `'\\''`)}'`;

/** The program each command-line tool is started with, before its prompt. */
const PROGRAMS: Partial<Record<CodingToolId, string>> = {
  'claude-code': 'claude',
  vscode: 'code chat',
  codex: 'codex',
};

/**
 * The terminal command for a tool without a URL scheme: switch to the
 * issue's branch, or create it, then start the tool with the prompt.
 */
export const codingCommand = (id: CodingToolId, issue: CodingIssue): string => {
  const program = PROGRAMS[id] ?? 'claude';
  const branch = shellQuote(issue.branch);
  return `(git switch ${branch} 2>/dev/null || git switch -c ${branch}) && ${program} ${shellQuote(codingPrompt(issue))}`;
};

/** The URL each tool with a scheme takes its prompt on, before the encoded prompt. */
const DEEP_LINKS: Partial<Record<CodingToolId, string>> = {
  cursor: 'cursor://anysphere.cursor-deeplink/prompt?text=',
};

/** A tool's deep link for a prompt. */
const linkFor = (id: CodingToolId, prompt: string): string =>
  `${DEEP_LINKS[id] ?? ''}${encodeURIComponent(prompt)}`;

/**
 * The deep link for a tool with a URL scheme, with the description shortened
 * when the whole prompt would not fit in {@link MAX_DEEP_LINK_LENGTH}.
 */
export const codingDeepLink = (
  id: CodingToolId,
  issue: CodingIssue
): string => {
  const full = linkFor(id, codingPrompt(issue));
  if (full.length <= MAX_DEEP_LINK_LENGTH) return full;
  let body = issue.body ?? '';
  let link = full;
  while (body.length > 0 && link.length > MAX_DEEP_LINK_LENGTH) {
    body = body.slice(0, Math.floor(body.length * 0.8));
    link = linkFor(
      id,
      codingPrompt({ ...issue, body: `${body.trimEnd()}\n\n${TRUNCATED_NOTE}` })
    );
  }
  return link.length <= MAX_DEEP_LINK_LENGTH
    ? link
    : linkFor(id, codingPrompt({ ...issue, body: TRUNCATED_NOTE }));
};

/** Hands a deep link to the operating system, which opens the tool that owns its scheme. */
const openLink = (href: string): void => {
  const anchor = globalThis.document.createElement('a');
  anchor.href = href;
  anchor.rel = 'noreferrer';
  anchor.style.display = 'none';
  globalThis.document.body.append(anchor);
  anchor.click();
  anchor.remove();
};

/**
 * Opens an issue in a tool: through its URL scheme when it has one, or by
 * copying its terminal command, and says which in a toast.
 */
export const openInCodingTool = (
  id: CodingToolId,
  issue: CodingIssue
): void => {
  const tool = codingTool(id);
  if (tool.kind === 'url') {
    openLink(codingDeepLink(id, issue));
    showToast(`Opening ${issue.key} in ${tool.name}`);
    return;
  }
  copyText(
    codingCommand(id, issue),
    `Copied the ${tool.name} command. Run it in your repository.`
  );
};
