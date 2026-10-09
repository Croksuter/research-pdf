// ─── "프로젝트로 이동": moving the document in front to another project ───

import { DEFAULT_PROJECT_ID, isDocInProject, pdfProjectTree, projectsOfDoc, type PdfProject } from '../../shared/pdfProjects';
import { S } from '../pdfHub.strings';
import { type HubTab, activeTab, ask, display, entryName, folders, isHub, library, libraryIdForUrl, loadOpenProjects, openProjectIds, openTabFor, pendingPins, pinnedDocIds, projectId, projectName, projects, sendProjectUpdate, tabName, tabs } from './store';
import { moveBtn, moveItems, moveNewForm, moveNewName, movePanel, moveTitle } from './dom';
import { el, hidePanels, icon, iconButton, listRow, showToast, registerPopover } from './uiKit';
import { PENDING_TIMEOUT_MS, activate, addDocs, removeTab, render } from './tabStrip';
import { handOver, withdrawHandOver } from './localFiles';
import { ensureFrame } from './frames';
import { openProject } from './session';
import { projectBadge } from './looks';
import { createProject } from './projectsPanel';

// "프로젝트로 이동": the document in front (or the one whose tab menu asked).
export let moveTarget: HubTab | null = null;

/** Where the document is now: this project, or (a guest here) the one it belongs to. */
export function moveSource(docId: string | null): string {
  if (!docId || isDocInProject(projects, projectId, docId)) return projectId;
  return projectsOfDoc(projects, docId)[0] ?? projectId;
}

export function renderMove(tab: HubTab): void {
  const docId = tab.docId ?? tab.libraryId ?? (tab.url ? libraryIdForUrl(tab.url) : null);
  const from = moveSource(docId);
  moveTitle.textContent = S.moveTitle(tabName(tab));
  // Every project is listed, grouped as in the project list; the ones already
  // holding the document are shown disabled rather than left out, so none
  // seems to have vanished.
  const holds = (id: string) => id === from || (!!docId && isDocInProject(projects, id, docId));
  const projectRowFor = (project: PdfProject, nested: boolean) => {
    const inside = holds(project.id);
    const where = project.id === projectId ? S.thisProject : S.alreadyIn;
    const actions = !inside && project.id !== DEFAULT_PROJECT_ID
      ? [iconButton('i-plus', S.alsoAddTitle, S.alsoAddAria(project.name), () => { hideMove(); void moveTab(tab, project.id, true); })]
      : [];
    const row = listRow({
      icon: projectBadge(project),
      title: project.name,
      sub: [openProjectIds.has(project.id) ? S.stateOpen : S.stateClosed, inside ? where : null].filter(Boolean).join(' · '),
      tooltip: inside ? S.alreadyInTitle : S.moveToThisProject,
      disabled: inside,
      onClick: () => { hideMove(); void moveTab(tab, project.id, false); },
      actions,
    });
    row.classList.toggle('is-disabled', inside);
    row.classList.toggle('is-nested', nested);
    return row;
  };
  const { root, items } = pdfProjectTree(projects, folders);
  const rows: HTMLElement[] = [projectRowFor(root, false)];
  for (const item of items) {
    if (item.kind === 'project') { rows.push(projectRowFor(item.project, false)); continue; }
    if (item.projects.length === 0) continue;
    const head = el('p', { className: 'rpdf-li-folder-head' });
    head.append(icon('i-folder'), el('span', { textContent: item.folder.name }));
    rows.push(head, ...item.projects.map((project) => projectRowFor(project, true)));
  }
  const every = [root, ...items.flatMap((item) => (item.kind === 'project' ? [item.project] : item.projects))];
  if (!every.some((p) => !holds(p.id))) rows.push(el('p', { className: 'rpdf-li-empty', textContent: S.noProjectsToMove }));
  moveItems.replaceChildren(...rows);
}

export function showMove(tab: HubTab | null = activeTab()): void {
  if (!tab) return;
  hidePanels();
  moveTarget = tab;
  movePanel.hidden = false;
  moveBtn.setAttribute('aria-expanded', 'true');
  moveNewName.value = '';
  renderMove(tab);
  void loadOpenProjects().then(() => { if (!movePanel.hidden && moveTarget) renderMove(moveTarget); });
  moveItems.querySelector<HTMLButtonElement>('.rpdf-li-main:not(:disabled)')?.focus();
}

export function hideMove(): void {
  if (movePanel.hidden) return;
  movePanel.hidden = true;
  moveTarget = null;
  moveBtn.setAttribute('aria-expanded', 'false');
}
registerPopover(movePanel, [moveBtn], hideMove);

moveBtn.addEventListener('click', () => { if (movePanel.hidden) showMove(); else hideMove(); });
moveNewForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const tab = moveTarget;
  const name = moveNewName.value;
  if (!tab) return;
  void createProject(name).then((id) => {
    if (!id) return;
    hideMove();
    void moveTab(tab, id, false);
  });
});

/**
 * Moves the tab's document to project `to` (`keep`: registers it there and
 * leaves it here). See moveDocs.
 */
export async function moveTab(tab: HubTab, to: string, keep: boolean): Promise<void> {
  const docId = tab.docId ?? tab.libraryId ?? (tab.url ? libraryIdForUrl(tab.url) : null);
  if (!docId) {
    const since = Date.now();
    tab.pendingMove = { to, keep, since };
    ensureFrame(tab);
    showToast(S.loadThenMove);
    setTimeout(() => {
      if (tab.pendingMove?.since !== since) return;
      tab.pendingMove = null;
      if (tabs.includes(tab)) showToast(S.moveGaveUp(tabName(tab)));
    }, PENDING_TIMEOUT_MS);
    return;
  }
  if (keep) { await addTabTo(tab, docId, to); return; }
  await moveDocs([{ docId, tab }], to);
}

async function addTabTo(tab: HubTab, docId: string, to: string): Promise<void> {
  const wasThere = isDocInProject(projects, to, docId);
  const response = await ask<{ success?: boolean; error?: string }>({
    type: 'VOCAB_T_PDF_PROJECT_MOVE', docId, url: tab.url, from: moveSource(docId), to, keep: true,
  });
  if (!response?.success) { showToast(response?.error ?? S.moveFailed); return; }
  showToast(
    S.alsoAddedTo(projectName(to)),
    wasThere ? undefined : { label: S.undo, run: () => { void sendProjectUpdate({ kind: 'member', id: to, docId, member: false }); } },
    { label: S.goTo(projectName(to)), run: () => { void goToProject(to, []); } },
  );
}

// ─── Moving documents: undo, going along, the note for the other hub ───

/** What a move changed, so undo can put it back: where the document was, its pin and its place, where its tab stood. */
interface MovedDoc { docId: string; from: string; url: string | null; pinned: boolean; pinOrder: string | null; index: number | null }
/** As moved from this hub: a local file's bytes, and the copy handed over. */
interface MovedFromHere extends MovedDoc { file: File | null; handoff: string | null }

export function docsLabel(docIds: string[]): string {
  return docIds.length === 1 && library[docIds[0]] ? S.docsOne(entryName(library[docIds[0]])) : S.docsMany(docIds.length);
}

/**
 * Moves the documents out of where they are (moveSource) into `to`. Their
 * tabs here go too: the background puts a web document in that project's
 * hub, or among the tabs it opens with; a local file is handed over
 * (localFiles.ts). Then, as the settings say, this hub stays — the toast can
 * undo or go there — or goes along, and that hub's toast can undo or come back.
 */
export async function moveDocs(items: Array<{ docId: string; tab: HubTab | undefined }>, to: string): Promise<void> {
  const follow = display.afterMove === 'follow' && to !== projectId;
  const pinsHere = new Set(pinnedDocIds());
  const moved: MovedFromHere[] = [];
  let error: string | null = null;
  for (const { docId, tab } of items) {
    const from = moveSource(docId);
    if (from === to || isDocInProject(projects, to, docId)) continue;
    // Moved into this project (a guest here): the tab stays.
    const leaving = tab && tabs.includes(tab) && to !== projectId ? tab : undefined;
    const handoff = leaving && !leaving.url ? await handOver(to, leaving, follow) : null;
    const response = await ask<{ success?: boolean; error?: string }>({
      type: 'VOCAB_T_PDF_PROJECT_MOVE', docId, url: leaving?.url ?? null, from, to, keep: false,
    });
    if (!response?.success) {
      if (handoff) await withdrawHandOver(handoff);
      error ??= response?.error ?? S.moveFailed;
      continue;
    }
    moved.push({
      docId,
      from,
      url: leaving?.url ?? null,
      pinned: from === projectId ? pinsHere.has(docId) : !!projects[from]?.members.find((m) => m.docId === docId)?.pinned,
      pinOrder: projects[from]?.members.find((m) => m.docId === docId)?.pinOrder ?? null,
      index: leaving ? tabs.indexOf(leaving) : null,
      file: leaving?.file ?? null,
      handoff,
    });
    pendingPins.delete(docId);
    if (leaving) removeTab(leaving);
  }
  render();
  if (moved.length === 0) { showToast(error ?? S.nothingToMove); return; }
  const note: MovedDoc[] = moved.map(({ file: _file, handoff: _handoff, ...doc }) => doc);
  if (follow) { await goToProject(to, note, projectId); return; }
  showToast(
    moved.length === 1 ? S.movedTo(projectName(to)) : S.movedDocs(moved.length, projectName(to)),
    { label: S.undo, run: () => { void undoMoveFromHere(to, moved); } },
    to === projectId ? undefined : { label: S.goTo(projectName(to)), run: () => { void goToProject(to, note); } },
  );
}

/** Undo in the hub they left: back where they were, with their pins, their tabs where they stood. */
async function undoMoveFromHere(to: string, moved: MovedFromHere[]): Promise<void> {
  for (const m of moved) {
    if (m.handoff) await withdrawHandOver(m.handoff);
    await ask({ type: 'VOCAB_T_PDF_PROJECT_MOVE', docId: m.docId, url: null, from: to, to: m.from, keep: false });
    await restorePin(m);
  }
  // Pinned ones come back as pins (storage → reconcilePinned); the others where they stood.
  let last: HubTab | null = null;
  for (const m of moved.filter((d) => !d.pinned && d.index !== null).sort((a, b) => (a.index as number) - (b.index as number))) {
    const doc = m.url ? { url: m.url, hash: '', file: null } : m.file ? { url: null, hash: '', file: m.file } : null;
    if (doc) last = addDocs([doc], false, false, m.index as number)[0] ?? last;
  }
  if (last) activate(last.key);
}

/** Undo in the hub they arrived at: back where they came from, and this tab goes back there too. */
async function undoArrival(notice: MoveNotice): Promise<void> {
  for (const m of notice.moved) {
    const tab = openTabFor(m.docId) ?? (m.url ? tabs.find((t) => t.url === m.url) : undefined);
    if (tab && !tab.url) await handOver(m.from, tab, true);
    await ask({ type: 'VOCAB_T_PDF_PROJECT_MOVE', docId: m.docId, url: tab?.url ?? null, from: notice.project, to: m.from, keep: false });
    await restorePin(m);
    if (tab) removeTab(tab);
  }
  render();
  await goToProject(notice.from, notice.moved);
}

async function restorePin(m: MovedDoc): Promise<void> {
  if (!m.pinned) return;
  await sendProjectUpdate({ kind: 'pin', id: m.from, docId: m.docId, pinned: true });
  if (m.pinOrder) await sendProjectUpdate({ kind: 'pin-order', id: m.from, order: [{ docId: m.docId, order: m.pinOrder }] });
}

// A note to the hub of the project gone to (in this tab after the switch, or
// in its own tab): bring these documents to the front, and (`arrivedFrom`)
// say where they came from, with undo and the way back. Session storage, so
// it reaches whichever page shows that project; it expires unread.
const MOVE_NOTICE_KEY = 'rpdfMoveNotice';
const MOVE_NOTICE_MS = 20_000;

interface MoveNotice { project: string; at: number; from: string; arrived: boolean; moved: MovedDoc[] }

async function goToProject(project: string, moved: MovedDoc[], arrivedFrom?: string): Promise<void> {
  if (moved.length || arrivedFrom) {
    const notice: MoveNotice = { project, at: Date.now(), from: arrivedFrom ?? projectId, arrived: !!arrivedFrom, moved };
    await chrome.storage.session.set({ [MOVE_NOTICE_KEY]: notice }).catch(() => undefined);
  }
  await openProject(project);
}

function parseMoveNotice(value: unknown): MoveNotice | null {
  const v = value as Partial<MoveNotice> | null | undefined;
  if (!v || typeof v.project !== 'string' || typeof v.from !== 'string' || typeof v.at !== 'number' || !Array.isArray(v.moved)) return null;
  return { project: v.project, from: v.from, at: v.at, arrived: v.arrived === true, moved: v.moved.filter((m): m is MovedDoc => !!m && typeof m.docId === 'string' && typeof m.from === 'string') };
}

/** Reads a note for this hub's project, if one is waiting. */
export async function takeMoveNotice(): Promise<void> {
  if (!isHub) return;
  const stored: Record<string, unknown> = await chrome.storage.session.get(MOVE_NOTICE_KEY).catch(() => ({}));
  const notice = parseMoveNotice(stored[MOVE_NOTICE_KEY]);
  if (!notice || notice.project !== projectId || Date.now() - notice.at > MOVE_NOTICE_MS) return;
  await chrome.storage.session.remove(MOVE_NOTICE_KEY).catch(() => undefined);
  // ponytail: a hub still frozen in the background may get the documents after the note; they then stay behind.
  let front: HubTab | undefined;
  for (const m of notice.moved) front = openTabFor(m.docId) ?? (m.url ? tabs.find((t) => t.url === m.url) : undefined) ?? front;
  if (front) activate(front.key);
  if (!notice.arrived) return;
  showToast(
    S.movedHere(docsLabel(notice.moved.map((m) => m.docId)), projectName(notice.from)),
    { label: S.undo, run: () => { void undoArrival(notice); } },
    { label: S.backTo(projectName(notice.from)), run: () => { void goToProject(notice.from, []); } },
  );
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[MOVE_NOTICE_KEY]?.newValue) void takeMoveNotice();
});

/**
 * This hub's project was deleted: its documents go to the default project —
 * this hub becomes it, or hands them to its open hub and closes.
 */
