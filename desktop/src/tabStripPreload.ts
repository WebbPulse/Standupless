/**
 * Draws the tab strip, the window's own local page, from the state the main
 * process sends, and sends back what the person does with it. It runs
 * sandboxed with context isolation, so it may only require `electron`: the
 * channel names are repeated here and must match `CHANNELS` in ipc.ts. Every
 * label is set as text, so a page title can never become markup.
 */

import { ipcRenderer, type IpcRendererEvent } from 'electron';
import type { StripState, StripTab, TabCommand } from './ipc';

const TABS_STATE = 'standupless:tabs-state';
const TAB_COMMAND = 'standupless:tab-command';

let current: StripState = { tabs: [], activeId: null, inset: false };
let dragging: number | null = null;

/** Sends a request to the main process. */
const send = (command: TabCommand): void => {
  ipcRenderer.send(TAB_COMMAND, command);
};

/** Whether a drop at `x` lands after the middle of `element`. */
const pastMiddle = (element: HTMLElement, x: number): boolean => {
  const rect = element.getBoundingClientRect();
  return x > rect.left + rect.width / 2;
};

/** Clears every drop marker. */
const clearMarkers = (): void => {
  document.querySelectorAll('.tab').forEach((element) => {
    element.classList.remove('drop-before', 'drop-after');
  });
};

/** Builds one tab. */
const drawTab = (tab: StripTab, index: number): HTMLElement => {
  const active = tab.id === current.activeId;
  const item = document.createElement('div');
  item.className = `tab${active ? ' active' : ''}${tab.loading ? ' loading' : ''}`;
  item.setAttribute('role', 'tab');
  item.setAttribute('aria-selected', String(active));
  item.tabIndex = active ? 0 : -1;
  item.title = tab.title;
  item.draggable = true;

  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = tab.title;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'close';
  close.textContent = '×';
  close.title = 'Close tab';
  close.setAttribute('aria-label', `Close ${tab.title}`);
  item.append(spinner, label, close);

  item.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault();
    if (event.button === 0 && event.target !== close) {
      send({ type: 'activate', id: tab.id });
    }
  });
  item.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    send({ type: 'close', id: tab.id });
  });
  item.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      send({ type: 'activate', id: tab.id });
    }
  });
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    send({ type: 'close', id: tab.id });
  });

  item.addEventListener('dragstart', (event) => {
    dragging = tab.id;
    if (event.dataTransfer !== null) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', tab.title);
    }
  });
  item.addEventListener('dragover', (event) => {
    if (dragging === null) return;
    event.preventDefault();
    clearMarkers();
    item.classList.add(
      pastMiddle(item, event.clientX) ? 'drop-after' : 'drop-before'
    );
  });
  item.addEventListener('dragleave', () => {
    item.classList.remove('drop-before', 'drop-after');
  });
  item.addEventListener('drop', (event) => {
    event.preventDefault();
    const id = dragging;
    if (id === null || id === tab.id) return;
    const from = current.tabs.findIndex((other) => other.id === id);
    let to = pastMiddle(item, event.clientX) ? index + 1 : index;
    if (from !== -1 && from < to) to -= 1;
    send({ type: 'move', id, index: to });
  });
  item.addEventListener('dragend', () => {
    dragging = null;
    render(current);
  });
  return item;
};

/** Redraws the strip, unless a drag is under way, which redraws when it ends. */
const render = (state: StripState): void => {
  current = state;
  if (dragging !== null) return;
  document.documentElement.classList.toggle('inset', state.inset);
  const list = document.getElementById('tabs');
  if (list === null) return;
  list.replaceChildren(...state.tabs.map(drawTab));
};

ipcRenderer.on(TABS_STATE, (_event: IpcRendererEvent, state: unknown) => {
  if (typeof state === 'object' && state !== null) render(state as StripState);
});

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('new')?.addEventListener('click', () => {
    send({ type: 'new' });
  });
  render(current);
});
