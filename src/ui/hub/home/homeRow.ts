// ─── One document row on home, and dragging pinned rows ───

import { moveInOrder } from '../../../shared/hubTabs';
import { libraryEntryKind, relativeTime, type PdfLibraryEntry } from '../../../shared/pdfLibrary';
import { S } from '../../pdfHub.strings';
import { annotated, currentProject, display, docRecords, entryName, entrySource, openTabFor, pinnedDocIds, projectId, registered, sendProjectUpdate, succeeded, updateError } from '../store';
import { homeSections } from '../dom';
import { el, icon, listRow, showToast } from '../uiKit';
import { setPinOrder, setPinnedById } from '../tabStrip';
import { openEntry } from './home';
import { removeDocsFromProject, renderSelectionBar, selected, showDocMenu } from './selection';
import { KIND_LABEL, kindIcon } from '../looks';

export interface HomeRowOptions {
  /** Pinned in this project (worked out once per render). */
  pinned: boolean;
  /** "+": register to this project without opening it. */
  add?: boolean;
  /** "−": take it out of this project (undo in the toast). */
  remove?: boolean;
  /** Names of the other projects it is in, shown in the meta line. */
  elsewhere?: string[];
  /** A row of the pinned list: dragged to reorder. */
  pinnedList?: boolean;
}

/** A round button on a home row (+, −). */
export function rowButton(name: string, title: string, aria: string, run: () => void, className = 'rpdf-item-act'): HTMLButtonElement {
  const button = el('button', { type: 'button', className, title });
  button.setAttribute('aria-label', aria);
  button.append(icon(name));
  button.addEventListener('click', run);
  return button;
}

export function homeRow(entry: PdfLibraryEntry, options: HomeRowOptions): HTMLElement {
  const { pinned } = options;
  const name = entryName(entry);
  const record = docRecords[entry.docId];
  const page = record?.page ?? null;
  const meta = [
    options.elsewhere?.length ? options.elsewhere.join(', ') : null,
    [entry.venue, entry.year].filter(Boolean).join(' '),
    entrySource(entry),
    relativeTime(entry.openedAt),
    page ? S.pageOf(page, entry.numPages) : S.pages(entry.numPages),
  ].filter(Boolean).join(' · ');
  const kind = libraryEntryKind(entry);
  const kindMark = icon(kindIcon(display.kindIcons === 'off' ? 'document' : kind, !(entry.urls[0] && !entry.urls[0].startsWith('file:'))));
  kindMark.dataset.kind = display.kindIcons === 'color' ? kind : '';
  const tooltip = [kind !== 'document' ? KIND_LABEL[kind] : null, entry.title, entry.docTitle, entry.fileName, ...entry.urls]
    .filter(Boolean).filter((v, i, all) => all.indexOf(v) === i).join('\n');
  const actions: HTMLElement[] = [];
  if (options.add) {
    actions.push(rowButton('i-plus', S.addToProjectTitle(currentProject().name), S.addToProjectAria(name, currentProject().name), () => {
      registered.add(entry.docId);
      void sendProjectUpdate({ kind: 'member', id: projectId, docId: entry.docId, member: true }).then((response) => {
        showToast(succeeded(response) ? S.addedTo(currentProject().name) : updateError(response, S.addFailed));
      });
    }));
  }
  if (options.remove) {
    actions.push(rowButton('i-minus', S.removeFromThisProject, S.removeFromProjectAria(name), () => removeDocsFromProject([entry.docId])));
  }
  const pin = rowButton('i-pin', pinned ? S.unpin : S.pinTitle, pinned ? S.unpinAria(name) : S.pinAria(name), () => setPinnedById(entry.docId, !pinned), 'rpdf-item-pin');
  pin.setAttribute('aria-pressed', String(pinned));
  const more = rowButton('i-more', S.more, S.moreFor(name), () => { const r = more.getBoundingClientRect(); showDocMenu([entry.docId], r.left - 160, r.bottom + 4); }, 'rpdf-item-act rpdf-item-more');
  actions.push(pin, more);
  const row = listRow({ variant: 'item', icon: kindMark, title: name, sub: meta, tooltip, onClick: () => openEntry(entry), actions });
  row.dataset.docId = entry.docId;
  const main = row.querySelector<HTMLButtonElement>('.rpdf-item-main');
  const badges = el('span', { className: 'rpdf-item-badges' });
  if (annotated.has(entry.docId)) {
    const pen = el('span', { className: 'rpdf-badge', title: S.hasAnnotations });
    pen.append(icon('i-pen'));
    badges.append(pen);
  }
  if (openTabFor(entry.docId)) badges.append(el('span', { className: 'rpdf-badge rpdf-badge-open', textContent: S.badgeOpen }));
  main?.append(badges);
  const isSelected = selected.has(entry.docId);
  row.classList.toggle('is-selected', isSelected);
  // Pinned rows are ordered by dragging, not selected.
  if (!options.pinnedList) {
    const check = el('input', { type: 'checkbox', className: 'rpdf-item-check', checked: isSelected });
    check.setAttribute('aria-label', S.selectAria(name));
    check.addEventListener('change', () => {
      if (check.checked) selected.add(entry.docId); else selected.delete(entry.docId);
      row.classList.toggle('is-selected', check.checked);
      renderSelectionBar();
    });
    row.prepend(check);
  }
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); showDocMenu([entry.docId], e.clientX, e.clientY); });
  if (page && entry.numPages > 1) {
    const bar = el('span', { className: 'rpdf-item-progress' });
    const fill = el('span');
    fill.style.width = `${Math.round(Math.min(1, page / entry.numPages) * 100)}%`;
    bar.append(fill);
    row.append(bar);
  }
  if (options.pinnedList) wirePinDrag(row, entry.docId);
  return row;
}

export let pinDragDoc: string | null = null;
export function wirePinDrag(row: HTMLElement, docId: string): void {
  row.draggable = true;
  row.classList.add('is-draggable');
  row.addEventListener('dragstart', (e) => {
    pinDragDoc = docId;
    row.classList.add('is-dragging');
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', docId); }
  });
  row.addEventListener('dragend', () => {
    pinDragDoc = null;
    row.classList.remove('is-dragging');
    for (const r of Array.from(homeSections.querySelectorAll('.drop-before, .drop-after'))) r.classList.remove('drop-before', 'drop-after');
  });
  const after = (e: DragEvent) => { const r = row.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
  row.addEventListener('dragover', (e) => {
    if (!pinDragDoc || pinDragDoc === docId) return;
    e.preventDefault();
    row.classList.toggle('drop-after', after(e));
    row.classList.toggle('drop-before', !after(e));
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
  row.addEventListener('drop', (e) => {
    const moving = pinDragDoc;
    row.classList.remove('drop-before', 'drop-after');
    if (!moving || moving === docId) return;
    e.preventDefault();
    setPinOrder(moveInOrder(pinnedDocIds(), moving, docId, after(e)));
  });
}
