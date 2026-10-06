// ─── Small UI pieces the hub's modules share ───
//
// Elements and icons, the one row shape (icon, title, line under it), the
// one menu, the toast, and the popovers: each panel registers itself, and a
// click elsewhere or the window losing focus closes it.

import { S } from '../pdfHub.strings';
import { menu, toast, toastAction, toastText } from './dom';

export const TOAST_MS = 5_000;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

export interface RowSpec {
  icon: Node;
  title: string;
  sub?: string | null;
  onClick?: () => void;
  /** Buttons after the row's main button. */
  actions?: HTMLElement[];
  /** 'li': a popover's row; 'item': a row on home. */
  variant?: 'li' | 'item';
  disabled?: boolean;
  tooltip?: string;
}

/** An icon, a title and a line under it, as one button; actions beside it. */
export function listRow(spec: RowSpec): HTMLElement {
  const item = spec.variant === 'item';
  const row = el(item ? 'li' : 'div', { className: item ? 'rpdf-item' : 'rpdf-li' });
  const main = el('button', { type: 'button', className: item ? 'rpdf-item-main' : 'rpdf-li-main' });
  const text = el('span', { className: item ? 'rpdf-item-text' : 'rpdf-li-text' });
  text.append(el('span', { className: item ? 'rpdf-item-title' : 'rpdf-li-title', textContent: spec.title }));
  if (spec.sub) text.append(el('span', { className: item ? 'rpdf-item-meta' : 'rpdf-li-sub', textContent: spec.sub }));
  main.append(spec.icon, text);
  if (spec.tooltip) main.title = spec.tooltip;
  if (spec.disabled) main.disabled = true;
  else if (spec.onClick) main.addEventListener('click', spec.onClick);
  row.append(main, ...(spec.actions ?? []));
  return row;
}

/** A small round icon button for a popover row. */
export function iconButton(name: string, label: string, aria: string, run: () => void): HTMLButtonElement {
  const button = el('button', { type: 'button', className: 'rpdf-li-action', title: label });
  button.setAttribute('aria-label', aria);
  button.append(icon(name));
  button.addEventListener('click', (e) => { e.stopPropagation(); run(); });
  return button;
}

export function copyUrl(url: string): void {
  void navigator.clipboard.writeText(url).then(() => showToast(S.urlCopied), () => showToast(S.urlCopyFailed));
}

export function hideMenu(): void {
  menu.hidden = true;
}

menu.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('.rpdf-menu-item:not(:disabled)'));
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
});

interface Popover { panel: HTMLElement; owners: Element[]; hide: () => void }
const popovers: Popover[] = [];

/** A panel that closes on a click outside it (and outside `owners`: its button, a menu it opens) or when the window loses focus. */
export function registerPopover(panel: HTMLElement, owners: Element[], hide: () => void): void {
  popovers.push({ panel, owners, hide });
}

// Clicking anywhere else, or into a document (the hub window loses focus).
document.addEventListener('pointerdown', (e) => {
  const target = e.target as Node;
  if (!menu.hidden && !menu.contains(target)) hideMenu();
  for (const { panel, owners, hide } of popovers) {
    if (!panel.hidden && !panel.contains(target) && !owners.some((o) => o.contains(target))) hide();
  }
}, true);
window.addEventListener('blur', () => hidePanels());

export function hidePanels(): void {
  hideMenu();
  for (const { hide } of popovers) hide();
}

// ─── Toast ───

export let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function showToast(message: string, action?: { label: string; run: () => void }): void {
  toastText.textContent = message;
  toastAction.hidden = !action;
  toastAction.textContent = action?.label ?? '';
  toastAction.onclick = action ? () => { hideToast(); action.run(); } : null;
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, TOAST_MS);
}

export function hideToast(): void {
  toast.hidden = true;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
}

export function menuAt(button: HTMLElement): { x: number; y: number } {
  const rect = button.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4 };
}

// ─── Menus for the list ───

export type MenuEntry = { label: string; run: () => void; disabled?: boolean; checked?: boolean } | 'sep' | { heading: string };

/** A small menu at (x, y); the panel it was opened from stays open. */
export function showMenu(entries: MenuEntry[], x: number, y: number): void {
  menu.replaceChildren();
  for (const entry of entries) {
    if (entry === 'sep') { menu.append(el('hr')); continue; }
    if ('heading' in entry) { menu.append(el('p', { className: 'rpdf-menu-head', textContent: entry.heading })); continue; }
    const button = el('button', { type: 'button', className: 'rpdf-menu-item', textContent: entry.label, disabled: !!entry.disabled });
    button.setAttribute('role', entry.checked === undefined ? 'menuitem' : 'menuitemradio');
    if (entry.checked !== undefined) button.setAttribute('aria-checked', String(entry.checked));
    button.addEventListener('click', () => { hideMenu(); entry.run(); });
    menu.append(button);
  }
  menu.hidden = false;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
  menu.querySelector<HTMLButtonElement>('.rpdf-menu-item:not(:disabled)')?.focus();
}
