// ─── Document info: its name, where it came from, the user's note and links ───
//
// One panel per document (the tab menu, a home row's menu, F2 on a tab): the
// name it goes by — the user's, or blank for the automatic one (the paper,
// else the file's own name) — every place it was opened from (web addresses,
// local paths) and its Drive copy, then a note and links the user keeps with
// it (web, file or a local path). All of it is the library row's
// (shared/pdfLibrary.ts), so it follows the document to every device. Edits
// are stored as they are made; nothing waits for a save button.

import { libraryEntryName, noteLinkUrl, pdfNoteLink, readableSource, type PdfLibraryEntry } from '../../shared/pdfLibrary';
import { pdfDisplayName } from '../../shared/localPdf';
import { S } from '../pdfHub.strings';
import { library, sendLibraryUpdate } from './store';
import { copyUrl, el, icon, iconButton, registerPopover, showToast } from './uiKit';
import { addDocs } from './tabStrip';

const panel = el('div', { className: 'rpdf-popover rpdf-docinfo', hidden: true });
panel.setAttribute('role', 'dialog');
document.body.append(panel);

let shownDoc: string | null = null;
let noteTimer: ReturnType<typeof setTimeout> | null = null;
/** Stores what is still being typed (the note), before the panel goes or shows another document. */
let flush: () => void = () => undefined;

export function hideDocInfo(): void {
  flush();
  panel.hidden = true;
  shownDoc = null;
}
registerPopover(panel, [], hideDocInfo);

panel.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideDocInfo(); }
});

/** Opens a place the document or a link points at: a PDF in this hub, anything else in a browser tab. */
function openPlace(url: string): void {
  const isPdf = /\.pdf(?:$|[?#])/iu.test(url) || url.startsWith('file:');
  if (isPdf && (url.startsWith('file:') || /^https?:/u.test(url))) {
    hideDocInfo();
    addDocs([{ url, hash: '', file: null }], true);
    return;
  }
  void chrome.tabs.create({ url });
}

function section(title: string, ...children: Node[]): HTMLElement {
  const box = el('section', { className: 'rpdf-docinfo-section' });
  box.append(el('h3', { className: 'rpdf-docinfo-head', textContent: title }), ...children);
  return box;
}

function sourceRow(label: string, title: string, iconName: string, open: () => void, copy?: string): HTMLElement {
  const row = el('div', { className: 'rpdf-docinfo-source' });
  const main = el('button', { type: 'button', className: 'rpdf-docinfo-source-main', title });
  main.append(icon(iconName), el('span', { textContent: label }));
  main.addEventListener('click', open);
  row.append(main);
  if (copy) row.append(iconButton('i-copy', S.copyUrl, S.copyUrl, () => copyUrl(copy)));
  return row;
}

/** Shows the document's info; `focus` puts the caret in the name (rename) or the note. */
export function showDocInfo(docId: string, focus: 'name' | 'note' | null = null): void {
  const entry = library[docId];
  if (!entry) { showToast(S.infoNotYet); return; }
  flush();
  shownDoc = docId;
  panel.hidden = false; // shown first: a hidden field takes no focus
  render(entry, focus);
}

/** The library changed (here or elsewhere): the open panel shows it, keeping what is being typed. */
export function refreshDocInfo(): void {
  if (panel.hidden || !shownDoc) return;
  const entry = library[shownDoc];
  if (!entry) { hideDocInfo(); return; }
  if (panel.contains(document.activeElement) && document.activeElement !== panel) return;
  render(entry, null);
}

function render(entry: PdfLibraryEntry, focus: 'name' | 'note' | null): void {
  const docId = entry.docId;
  const auto = libraryEntryName({ ...entry, userTitle: null }, pdfDisplayName);

  const closeBtn = iconButton('i-close', S.close, S.close, hideDocInfo);
  const head = el('div', { className: 'rpdf-docinfo-top' });
  head.append(el('p', { className: 'rpdf-ask-title', textContent: S.docInfoTitle }), closeBtn);

  // ── Name
  const name = el('input', { type: 'text', className: 'rpdf-docinfo-input', value: entry.userTitle ?? '', placeholder: auto, maxLength: 300, spellcheck: false });
  name.setAttribute('aria-label', S.docInfoName);
  const saveName = () => {
    const value = name.value.trim() || null;
    if (value === (library[docId]?.userTitle ?? null)) return;
    void sendLibraryUpdate({ kind: 'rename', docId, userTitle: value });
  };
  name.addEventListener('change', saveName);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveName(); name.blur(); } });
  const nameHint = el('p', { className: 'rpdf-docinfo-hint', textContent: S.docInfoNameHint(auto) });

  // ── Where it came from
  const sources: HTMLElement[] = entry.urls.map((url) => {
    const local = url.startsWith('file:');
    return sourceRow(readableSource(url), local ? S.docInfoOpenLocal : S.docInfoOpenWeb, local ? 'i-file-local' : 'i-globe', () => openPlace(url), local ? readableSource(url) : url);
  });
  // No address at all: a local file picked or dropped, whose path the browser keeps to itself.
  if (sources.length === 0) {
    sources.push(el('p', { className: 'rpdf-docinfo-hint', textContent: entry.fileName ? S.docInfoPickedFile(entry.fileName) : S.docInfoNoSource }));
  }

  // ── Note and links
  const note = el('textarea', { className: 'rpdf-docinfo-note', rows: 3, maxLength: 4000, value: entry.note ?? '', placeholder: S.docInfoNotePlaceholder });
  note.setAttribute('aria-label', S.docInfoNote);
  let links = [...entry.links];
  const saveNote = () => {
    if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
    const current = library[docId];
    const value = note.value.trim() || null;
    if (current && value === current.note && JSON.stringify(links) === JSON.stringify(current.links)) return;
    void sendLibraryUpdate({ kind: 'note', docId, note: value, links });
  };
  note.addEventListener('input', () => {
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(saveNote, 800);
  });
  note.addEventListener('change', saveNote);
  flush = () => { saveNote(); saveName(); };

  const linkList = el('div', { className: 'rpdf-docinfo-links' });
  const drawLinks = () => {
    linkList.replaceChildren(...links.map((link) => {
      const row = sourceRow(link, S.docInfoOpenLink, /^https?:/u.test(link) ? 'i-globe' : 'i-file-local', () => openPlace(noteLinkUrl(link)), link);
      row.append(iconButton('i-minus', S.docInfoRemoveLink, S.docInfoRemoveLink, () => { links = links.filter((l) => l !== link); drawLinks(); saveNote(); }));
      return row;
    }));
  };
  drawLinks();
  const addInput = el('input', { type: 'text', className: 'rpdf-docinfo-input', placeholder: S.docInfoLinkPlaceholder, spellcheck: false });
  addInput.setAttribute('aria-label', S.docInfoAddLink);
  const add = () => {
    const link = pdfNoteLink(addInput.value);
    if (!link) { if (addInput.value.trim()) showToast(S.docInfoBadLink); return; }
    if (!links.includes(link)) links = [...links, link].slice(0, 12);
    addInput.value = '';
    drawLinks();
    saveNote();
  };
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  const addBtn = iconButton('i-plus', S.docInfoAddLink, S.docInfoAddLink, add);
  const addRow = el('div', { className: 'rpdf-docinfo-add' });
  addRow.append(addInput, addBtn);

  panel.setAttribute('aria-label', S.docInfoTitle);
  panel.replaceChildren(
    head,
    section(S.docInfoName, name, nameHint),
    section(S.docInfoSources, ...sources),
    section(S.docInfoNote, note),
    section(S.docInfoLinks, linkList, addRow),
  );
  if (focus === 'name') { name.focus(); name.select(); }
  else if (focus === 'note') note.focus();
}
