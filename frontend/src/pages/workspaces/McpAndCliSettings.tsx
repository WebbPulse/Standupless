/**
 * The MCP and CLI settings page: where a person finds the MCP server address
 * and the setup for each assistant, and how to install the CLI and sign it
 * in. Any member reaches it, because both act as the person who connects them.
 *
 * Every address on the page comes from the API base the application itself
 * calls, so a staging build never hands out a production address.
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { LuArrowRight, LuKeyRound } from 'react-icons/lu';
import { Link, useLocation } from 'react-router-dom';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { CodeBlock } from '../../components/ui/code-block';
import { useCopy } from '../../hooks/useCopy';
import Button from '../../components/ui/button';
import { TextLink } from '../../components/ui/link';
import { useWorkspace } from '../../hooks/useWorkspace';
import { cn } from '../../lib/cn';
import {
  CLI_INSTALL_PIPX,
  CLI_INSTALL_PIP,
  claudeCodeCommand,
  cliTargetFlags,
  cursorConfig,
  mcpServerUrl,
  vscodeConfig,
} from '../../lib/connect';
import { apiKeysPath, connectedAppsPath } from '../../lib/paths';

/** The assistants the MCP section has setup steps for. */
type Client = 'claude-code' | 'claude' | 'cursor' | 'vscode' | 'other';

/** The tab order and the name each tab reads as. */
const CLIENTS: { id: Client; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'claude', label: 'Claude' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'vscode', label: 'VS Code' },
  { id: 'other', label: 'Other' },
];

const SECTION = 'scroll-mt-4 space-y-4';
const NOTE = 'text-sm text-text-muted';
const CODE = 'rounded-xs bg-raised px-1 py-px font-mono text-xs text-text';

/** An inline command or path inside a sentence. */
const Inline: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <code className={CODE}>{children}</code>
);

/** The server address in a read-only row with a copy button. */
const ServerUrl: React.FC<{ url: string }> = ({ url }) => {
  const { copied, copy } = useCopy();
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-text-muted">
        Server URL
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          readOnly
          value={url}
          onFocus={(event) => {
            event.target.select();
          }}
          className="h-8 min-w-0 flex-1 rounded-sm border border-line bg-surface px-2.5 font-mono text-xs text-text focus:border-accent focus:outline-none"
        />
        <Button
          size="md"
          onClick={() => {
            copy(url);
          }}
        >
          {copied ? 'Copied' : 'Copy URL'}
        </Button>
      </div>
    </div>
  );
};

/** The setup steps for one assistant. */
const ClientSetup: React.FC<{ client: Client; url: string }> = ({
  client,
  url,
}) => {
  switch (client) {
    case 'claude-code':
      return (
        <div className="space-y-3">
          <p className={NOTE}>Add the server from your terminal:</p>
          <CodeBlock
            code={claudeCodeCommand(url)}
            label="Claude Code command"
            prompt
          />
          <p className={NOTE}>
            Then run <Inline>/mcp</Inline> in Claude Code, pick{' '}
            <Inline>standupless</Inline> and follow the browser sign in.
          </p>
        </div>
      );
    case 'claude':
      return (
        <div className="space-y-3">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-text-muted marker:text-text-faint">
            <li>
              In Claude on the web or Claude Desktop, open{' '}
              <span className="text-text">Customize</span>, then{' '}
              <span className="text-text">Connectors</span>.
            </li>
            <li>
              Choose <span className="text-text">+</span>, then{' '}
              <span className="text-text">Add custom connector</span>.
            </li>
            <li>
              Paste the server URL above, choose{' '}
              <span className="text-text">Add</span>, then{' '}
              <span className="text-text">Connect</span> to sign in.
            </li>
          </ol>
          <p className="text-xs text-text-faint">
            On a Team or Enterprise plan, an organization owner adds the
            connector under Organization settings, Connectors first, and members
            then connect to it.
          </p>
        </div>
      );
    case 'cursor':
      return (
        <div className="space-y-3">
          <p className={NOTE}>
            Add the server to <Inline>~/.cursor/mcp.json</Inline>, or to{' '}
            <Inline>.cursor/mcp.json</Inline> in a project:
          </p>
          <CodeBlock code={cursorConfig(url)} label="Cursor configuration" />
          <p className={NOTE}>
            Cursor asks you to sign in the first time it connects.
          </p>
        </div>
      );
    case 'vscode':
      return (
        <div className="space-y-3">
          <p className={NOTE}>
            Add the server to <Inline>.vscode/mcp.json</Inline> in your
            workspace:
          </p>
          <CodeBlock code={vscodeConfig(url)} label="VS Code configuration" />
          <p className={NOTE}>
            Start the server from the file and sign in when VS Code asks.
          </p>
        </div>
      );
    case 'other':
      return (
        <p className={NOTE}>
          Any MCP client that supports remote HTTP servers with OAuth can
          connect. Give it the server URL above and complete the sign in it
          opens.
        </p>
      );
  }
};

/** The assistant tabs, moved between with the arrow keys as well as clicks. */
const ClientTabs: React.FC<{ url: string }> = ({ url }) => {
  const [client, setClient] = useState<Client>('claude-code');
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const at = CLIENTS.findIndex((row) => row.id === client);
    const step =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? CLIENTS.length - 1
          : step === 0
            ? null
            : (at + step + CLIENTS.length) % CLIENTS.length;
    if (next === null) return;
    event.preventDefault();
    const target = CLIENTS[next];
    if (target === undefined) return;
    setClient(target.id);
    tabs.current[next]?.focus();
  };

  return (
    <div className="space-y-3">
      <div
        role="tablist"
        aria-label="Assistant"
        onKeyDown={onKeyDown}
        className="flex flex-wrap items-center gap-1 border-b border-line pb-2"
      >
        {CLIENTS.map((row, index) => {
          const selected = row.id === client;
          return (
            <button
              key={row.id}
              ref={(node) => {
                tabs.current[index] = node;
              }}
              id={`${baseId}-tab-${row.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                setClient(row.id);
              }}
              className={cn(
                'inline-flex h-7 items-center rounded-sm px-2.5 text-xs font-medium transition-colors duration-100',
                selected
                  ? 'bg-raised text-text'
                  : 'text-text-muted hover:bg-surface hover:text-text'
              )}
            >
              {row.label}
            </button>
          );
        })}
      </div>
      <div
        id={`${baseId}-panel`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${client}`}
      >
        <ClientSetup client={client} url={url} />
      </div>
    </div>
  );
};

/** One numbered step of the CLI setup. */
const Step: React.FC<{
  n: number;
  title: string;
  children: React.ReactNode;
}> = ({ n, title, children }) => (
  <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3">
    <span
      aria-hidden="true"
      className="mt-px flex h-5 w-5 items-center justify-center rounded-full border border-line text-2xs text-text-muted tabular-nums"
    >
      {n}
    </span>
    <div className="min-w-0 space-y-2">
      <h3 className="text-sm font-medium text-text">{title}</h3>
      {children}
    </div>
  </li>
);

/** Scrolls to the section the location's hash names, each time it changes. */
const useHashScroll = (ready: boolean): void => {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready || hash === '') return;
    const target = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (typeof target?.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start' });
    }
  }, [hash, ready]);
};

/** Renders the MCP server setup and the CLI install steps. */
const McpAndCliSettings: React.FC = () => {
  const { workspace } = useWorkspace();
  const url = mcpServerUrl();
  const target = cliTargetFlags();
  useHashScroll(workspace !== null);

  return (
    <WorkspaceShell
      title="Settings"
      toolbar={
        workspace === null ? undefined : <SettingsNav workspace={workspace} />
      }
    >
      {workspace !== null && (
        <div className="max-w-2xl space-y-12">
          <section id="mcp" aria-labelledby="mcp-title" className={SECTION}>
            <div className="space-y-1">
              <h2 id="mcp-title" className="text-base font-semibold">
                MCP server
              </h2>
              <p className={NOTE}>
                Connect an AI assistant that supports the Model Context Protocol
                so it can search, read, create and update issues for you. The
                first time it connects, it opens your browser to sign in and
                asks which workspaces it may use. No API key is needed.
              </p>
            </div>

            <ServerUrl url={url} />
            <ClientTabs url={url} />

            <p className="flex flex-wrap items-center gap-x-1 border-t border-line pt-3 text-xs text-text-muted">
              Assistants you authorize are listed under
              <TextLink to={connectedAppsPath(workspace.slug)}>
                Connected apps
              </TextLink>
              , where you can revoke them.
            </p>
          </section>

          <section id="cli" aria-labelledby="cli-title" className={SECTION}>
            <div className="space-y-1">
              <h2 id="cli-title" className="text-base font-semibold">
                CLI
              </h2>
              <p className={NOTE}>
                The <Inline>standupless</Inline> command lists, creates, edits
                and closes issues from your terminal, and prints JSON for
                scripts with <Inline>--json</Inline>. It signs in with an API
                key and needs Python 3.11 or later.
              </p>
            </div>

            <ol className="space-y-6">
              <Step n={1} title="Install">
                <CodeBlock
                  code={CLI_INSTALL_PIP}
                  label="pip install command"
                  prompt
                />
                <p className="text-xs text-text-faint">
                  Or with pipx, to keep it in its own environment:
                </p>
                <CodeBlock
                  code={CLI_INSTALL_PIPX}
                  label="pipx install command"
                  prompt
                />
              </Step>

              <Step n={2} title="Create an API key">
                <p className={NOTE}>
                  A personal key acts as you. Give it the scopes for what you
                  plan to run, such as <Inline>issues:read</Inline>,{' '}
                  <Inline>issues:write</Inline> and <Inline>teams:read</Inline>.
                </p>
                <Link
                  to={apiKeysPath(workspace.slug)}
                  className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-line-strong bg-bg px-2 text-xs font-medium text-text transition-colors duration-100 hover:bg-raised"
                >
                  <LuKeyRound aria-hidden="true" className="h-3.5 w-3.5" />
                  Create API key
                  <LuArrowRight
                    aria-hidden="true"
                    className="h-3 w-3 text-text-faint"
                  />
                </Link>
              </Step>

              <Step n={3} title="Sign in">
                <CodeBlock
                  code={`standupless${target} auth login`}
                  label="sign in command"
                  prompt
                />
                <p className={NOTE}>
                  Paste the key when prompted. It is kept in your operating
                  system keyring, and <Inline>standupless auth status</Inline>{' '}
                  shows who you are signed in as.
                </p>
              </Step>

              <Step n={4} title="Try it">
                <CodeBlock
                  code={[
                    'standupless issue list -a me',
                    'standupless issue create --title "Fix login" -t ENG',
                    'git switch -c "$(standupless issue branch ENG-12)"',
                  ].join('\n')}
                  label="example commands"
                  prompt
                />
                <p className={NOTE}>
                  Swap <Inline>ENG</Inline> for one of your team keys. Run{' '}
                  <Inline>standupless --help</Inline> for every command.
                </p>
              </Step>
            </ol>
          </section>
        </div>
      )}
    </WorkspaceShell>
  );
};

export default McpAndCliSettings;
