// ─── Actions on documents: a row's ⋯, the selection and its bar ───

import { showDocInfo } from '../docInfo';
import { type HubClosedTab, visibleSelection } from '../../../shared/hubTabs';
import { DEFAULT_PROJECT_ID, isDocInProject, pdfProjectTree, type PdfProject } from '../../../shared/pdfProjects';
import { libraryEntryKind } from '../../../shared/pdfLibrary';
import { S } from '../../pdfHub.strings';
import { folders, library, openTabFor, pendingPins, pinnedDocIds, projectId, projectName, projects, registered, sendProjectUpdate, succeeded, tabs, updateError } from '../store';
import { home } from '../dom';
import { type MenuEntry, copyUrl, el, showMenu, showToast } from '../uiKit';
import { closeTab, closedEntry, setPinnedById } from '../tabStrip';
import { openProject, reopenEntries } from '../session';
import { openEntry, scheduleHomeRender } from './home';
import { KIND_LABEL, showKindMenu } from '../looks';
import { docsLabel, moveDocs } from '../movePanel';

// Selected rows; always a subset of the rows on screen (see renderHome).
export let selected = new Set<string>();

/** Keeps only the selected rows still on screen. */
export function keepSelected(visible: string[]): void {
  selected = visibleSelection(selected, visible);
}

// ─── Actions on documents (a row's ⋯, or the selection) ───

/** Projects to offer for `docIds`: live ones but this one, in list order; `holds` marks where all of them already are. */
export function projectChoices(docIds: string[]): Array<{ project: PdfProject; holds: boolean }> {
  const { root, items } = pdfProjectTree(projects, folders);
  const all = [root, ...items.flatMap((item) => (item.kind === 'project' ? [item.project] : item.projects))];
  return all.filter((p) => p.id !== projectId).map((project) => ({ project, holds: docIds.every((id) => isDocInProject(projects, project.id, id)) }));
}

/** Registers the documents to `to` too (they stay where they are). */
export function addDocsToProject(docIds: string[], to: string): void {
  const added = docIds.filter((docId) => !isDocInProject(projects, to, docId));
  void Promise.all(docIds.map((docId) => sendProjectUpdate({ kind: 'member', id: to, docId, member: true }))).then((responses) => {
    const failed = responses.find((r) => !succeeded(r));
    if (failed) { showToast(updateError(failed, S.addFailed)); return; }
    showToast(
      S.addedDocsTo(docsLabel(docIds), projectName(to)),
      added.length ? { label: S.undo, run: () => { for (const docId of added) void sendProjectUpdate({ kind: 'member', id: to, docId, member: false }); } } : undefined,
      { label: S.goTo(projectName(to)), run: () => { void openProject(to); } },
    );
  });
}

/** Moves the documents to `to`: open tabs here go with them (movePanel.moveDocs). */
export function moveDocsToProject(docIds: string[], to: string): Promise<void> {
  return moveDocs(docIds.map((docId) => ({ docId, tab: openTabFor(docId) })), to);
}

/** What taking a document out of this project changed, so undo can put all of it back. */
export interface RemovedDoc { docId: string; pinned: boolean; pinOrder: string | null; tab: HubClosedTab | null }

/** Takes the documents out of this project: membership, pin (and its place), open tab — all back with undo. */
export function removeDocsFromProject(docIds: string[]): void {
  const project = projectId;
  const inside = docIds.filter((id) => project !== DEFAULT_PROJECT_ID && isDocInProject(projects, project, id));
  if (inside.length === 0) { showToast(S.nothingToRemove); return; }
  const pinnedNow = new Set(pinnedDocIds());
  const removed: RemovedDoc[] = inside.map((docId) => {
    const tab = openTabFor(docId);
    return {
      docId,
      pinned: pinnedNow.has(docId),
      pinOrder: projects[project]?.members.find((m) => m.docId === docId)?.pinOrder ?? null,
      tab: tab ? closedEntry(tab, tabs.indexOf(tab)) : null,
    };
  });
  for (const r of removed) {
    void sendProjectUpdate({ kind: 'member', id: project, docId: r.docId, member: false });
    registered.add(r.docId); // closing it must not register it again
    pendingPins.delete(r.docId);
    const tab = openTabFor(r.docId);
    if (tab) { tab.pinned = false; tab.keepOnUnpin = false; closeTab(tab.key, false); }
  }
  selected = new Set([...selected].filter((id) => !inside.includes(id)));
  scheduleHomeRender();
  showToast(S.removedDocs(docsLabel(inside)), { label: S.undo, run: () => { void restoreRemoved(project, removed); } });
}

export async function restoreRemoved(project: string, removed: RemovedDoc[]): Promise<void> {
  if (project !== projectId) return;
  for (const r of removed) {
    await sendProjectUpdate({ kind: 'member', id: project, docId: r.docId, member: true });
    if (!r.pinned) continue;
    await sendProjectUpdate({ kind: 'pin', id: project, docId: r.docId, pinned: true });
    if (r.pinOrder) await sendProjectUpdate({ kind: 'pin-order', id: project, order: [{ docId: r.docId, order: r.pinOrder }] });
  }
  // Pinned ones come back as pins (storage → reconcilePinned); the others where they were.
  const reopen = removed.filter((r) => !r.pinned && r.tab).map((r) => r.tab as HubClosedTab);
  if (reopen.length) reopenEntries(reopen);
}

export function showProjectPicker(docIds: string[], mode: 'add' | 'move', x: number, y: number): void {
  const choices = projectChoices(docIds).filter((c) => mode === 'move' || c.project.id !== DEFAULT_PROJECT_ID);
  showMenu([
    { heading: mode === 'add' ? S.addToAnother : S.moveToAnother },
    ...choices.map(({ project, holds }) => ({
      label: holds ? S.alreadyHas(project.name) : project.name,
      disabled: holds,
      run: () => {
        if (mode === 'add') addDocsToProject(docIds, project.id);
        else void moveDocsToProject(docIds, project.id);
        selected.clear();
        scheduleHomeRender();
      },
    })),
    ...(choices.length === 0 ? [{ label: S.noOtherProjects, disabled: true, run: () => undefined }] : []),
  ], x, y);
}

export function showDocMenu(docIds: string[], x: number, y: number): void {
  const one = docIds.length === 1 ? library[docIds[0]] : undefined;
  const pinnedNow = new Set(pinnedDocIds());
  const allPinned = docIds.every((id) => pinnedNow.has(id));
  const inHere = projectId !== DEFAULT_PROJECT_ID && docIds.some((id) => isDocInProject(projects, projectId, id));
  const entries: MenuEntry[] = [];
  if (one) entries.push({ label: S.open, run: () => openEntry(one) });
  entries.push(
    { label: allPinned ? S.unpin : S.pin, run: () => { for (const id of docIds) setPinnedById(id, !allPinned); } },
    'sep',
    { label: `${S.addToAnother}…`, run: () => showProjectPicker(docIds, 'add', x, y) },
    { label: `${S.moveToAnother}…`, run: () => showProjectPicker(docIds, 'move', x, y) },
  );
  if (inHere) entries.push({ label: S.removeFromThisProject, run: () => { removeDocsFromProject(docIds); selected.clear(); scheduleHomeRender(); } });
  if (one) {
    entries.push('sep', { label: S.docInfoMenu, run: () => showDocInfo(one.docId, 'name') });
    entries.push({ label: S.kindMenuItem(KIND_LABEL[libraryEntryKind(one)]), run: () => showKindMenu(one.docId, x, y) });
    const url = one.urls[0];
    if (url) entries.push({ label: S.copyUrl, run: () => copyUrl(url) });
  }
  showMenu(entries, x, y);
}

// The bar at the bottom of home while documents are selected.
export const selectionBar = el('div', { className: 'rpdf-selbar', hidden: true });
selectionBar.setAttribute('role', 'toolbar');
selectionBar.setAttribute('aria-label', S.selectionAria);
home.append(selectionBar);

export function renderSelectionBar(): void {
  for (const id of [...selected]) if (!library[id]) selected.delete(id);
  selectionBar.hidden = selected.size === 0;
  home.classList.toggle('has-selection', selected.size > 0);
  if (selected.size === 0) { selectionBar.replaceChildren(); return; }
  const ids = [...selected];
  const button = (label: string, run: (b: HTMLButtonElement) => void) => {
    const b = el('button', { type: 'button', className: 'rpdf-selbar-btn', textContent: label });
    b.addEventListener('click', () => run(b));
    return b;
  };
  const at = (b: HTMLButtonElement) => { const r = b.getBoundingClientRect(); return { x: r.left, y: r.top - 8 - Math.min(320, 34 * (projectChoices(ids).length + 1)) }; };
  const pinnedNow = new Set(pinnedDocIds());
  const allPinned = ids.every((id) => pinnedNow.has(id));
  const inHere = projectId !== DEFAULT_PROJECT_ID && ids.some((id) => isDocInProject(projects, projectId, id));
  const done = () => { selected.clear(); renderSelectionBar(); scheduleHomeRender(); };
  selectionBar.replaceChildren(
    el('span', { className: 'rpdf-selbar-count', textContent: S.selectedCount(selected.size) }),
    el('span', { className: 'rpdf-selbar-gap' }),
    button(S.addToAnother, (b) => { const p = at(b); showProjectPicker(ids, 'add', p.x, p.y); }),
    button(S.moveShort, (b) => { const p = at(b); showProjectPicker(ids, 'move', p.x, p.y); }),
    button(allPinned ? S.unpin : S.pin, () => { for (const id of ids) setPinnedById(id, !allPinned); done(); }),
    ...(inHere ? [button(S.removeFromThisProject, () => { removeDocsFromProject(ids); done(); })] : []),
    button(S.clearSelection, done),
  );
}
