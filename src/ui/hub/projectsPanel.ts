// ─── The project switcher: the list, folders, order, rename, create, delete ───

import { DEFAULT_PROJECT_ID, cleanPdfProjectName, newPdfProjectFolderId, newPdfProjectId, pdfProjectTree, type PdfFolderUpdate, type PdfProject, type PdfProjectFolder, type PdfProjectUpdate } from '../../shared/pdfProjects';
import { compareOrderKeys, orderKeyAtEnd, orderKeyBetween, orderKeysBetween } from '../../shared/orderKey';
import { S } from '../pdfHub.strings';
import { currentProject, folders, library, loadOpenProjects, membershipIndex, openProjectIds, projectId, projects, sendProjectUpdate, succeeded, updateError, setFoldersLocally } from './store';
import { folderNewBtn, projectBadgeEl, projectBtn, projectNameEl, projectNewForm, projectNewName, projectsItems, projectsPanel, stylePanel, menu } from './dom';
import { type MenuEntry, el, hidePanels, icon, iconButton, listRow, menuAt, showMenu, showToast, registerPopover } from './uiKit';
import { openProject } from './session';
import { fillBadge, hideStyle, projectBadge, showStyle, updateFavicon } from './looks';

// ─── Projects: switcher, move, rehoming ───

export function projectDocCount(project: PdfProject, index: Map<string, string[]>): number {
  if (project.id !== DEFAULT_PROJECT_ID) return project.members.filter((m) => m.member).length;
  return Object.keys(library).filter((docId) => !index.has(docId)).length;
}

export function updateProjectLabel(): void {
  const name = currentProject().name;
  projectNameEl.textContent = name;
  fillBadge(projectBadgeEl, currentProject());
  updateFavicon();
  projectBtn.title = S.projectBtnTitle(name);
  projectBtn.setAttribute('aria-label', S.projectBtnAria(name));
}

export async function createProject(rawName: string): Promise<string | null> {
  const name = cleanPdfProjectName(rawName);
  if (!name) return null;
  const id = newPdfProjectId();
  // Awaited: the next request (open, move) must find the project stored.
  const response = await sendProjectUpdate({ kind: 'create', id, name });
  if (!succeeded(response)) { showToast(updateError(response, S.projectCreateFailed)); return null; }
  return id;
}

/**
 * Shows project `id`: in this tab (the default), or in a new tab next to it.
 * A project already open in another tab is brought forward instead.
 */

// The list: the default project, then folders (one level) and projects in
// the user's order. Rows drag to reorder or into / out of folders, Alt+↑/↓
// moves the focused one; "⋯" (or a right click) has the rest.

export type ListRef = { kind: 'project' | 'folder'; id: string };
export const COLLAPSED_KEY = 'rpdfFoldersCollapsed';
export let dragging: ListRef | null = null;
export let focusAfterRender: string | null = null;

export function collapsedFolders(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

export function setFolderCollapsed(id: string, collapsed: boolean): void {
  const ids = collapsedFolders();
  if (collapsed) ids.add(id); else ids.delete(id);
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids])); } catch { /* per-device nicety */ }
}

export function rowAction(row: HTMLElement, name: string, label: string, run: (button: HTMLButtonElement) => void, subject: string): HTMLButtonElement {
  const button = iconButton(name, label, S.rowActionAria(subject, label), () => run(button));
  row.append(button);
  return button;
}

export function projectRow(project: PdfProject, index: Map<string, string[]>, folder: string | null): HTMLElement {
  const current = project.id === projectId;
  const open = current || openProjectIds.has(project.id);
  const row = listRow({
    icon: projectBadge(project),
    title: project.name,
    sub: [current ? S.viewingNow : open ? S.stateOpen : null, S.docCount(projectDocCount(project, index))].filter(Boolean).join(' · '),
    onClick: () => { hideProjects(); void openProject(project.id); },
  });
  row.classList.toggle('is-current', current);
  row.classList.toggle('is-nested', folder !== null);
  row.dataset.kind = project.id === DEFAULT_PROJECT_ID ? 'root' : 'project';
  row.dataset.id = project.id;
  row.dataset.parent = folder ?? '';
  if (current) row.querySelector('.rpdf-li-main')?.setAttribute('aria-current', 'true');
  if (!current) rowAction(row, 'i-open-new', S.openInNewTab, () => { hideProjects(); void openProject(project.id, 'new-tab'); }, project.name);
  rowAction(row, 'i-more', S.more, (button) => { const at = menuAt(button); showProjectMenu(project, at.x, at.y); }, project.name);
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); showProjectMenu(project, e.clientX, e.clientY); });
  wireListDrag(row);
  return row;
}

export function folderRow(folder: PdfProjectFolder, count: number, shut: boolean): HTMLElement {
  const chevron = icon('i-chevron');
  chevron.classList.add('rpdf-folder-chevron');
  const icons = document.createDocumentFragment();
  icons.append(chevron, icon('i-folder'));
  const row = listRow({
    icon: icons,
    title: folder.name,
    sub: count ? S.folderProjectCount(count) : S.folderEmpty,
    tooltip: shut ? S.expand : S.collapse,
    onClick: () => { setFolderCollapsed(folder.id, !shut); focusAfterRender = folder.id; renderProjects(); },
  });
  row.classList.add('rpdf-folder');
  row.classList.toggle('is-shut', shut);
  row.dataset.kind = 'folder';
  row.dataset.id = folder.id;
  row.dataset.parent = '';
  row.querySelector('.rpdf-li-main')?.setAttribute('aria-expanded', String(!shut));
  rowAction(row, 'i-more', S.more, (button) => { const at = menuAt(button); showFolderMenu(folder, at.x, at.y); }, folder.name);
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); showFolderMenu(folder, e.clientX, e.clientY); });
  wireListDrag(row);
  return row;
}

// A row being renamed or asking for confirmation is left alone by renders
// (a storage change from anywhere would otherwise wipe what is being typed);
// the list catches up when it is done.

export function rowBusy(): boolean {
  return !!projectsItems.querySelector('.rpdf-li-rename, .rpdf-li-confirm');
}

/** Turns a row into a name field; `save` gets the cleaned new name (an empty `name` asks for a new one). */
export function startRename(row: HTMLElement, name: string, label: string, save: (name: string) => void): void {
  const input = el('input', { type: 'text', className: 'rpdf-li-rename', value: name, maxLength: 60, placeholder: label });
  input.setAttribute('aria-label', label);
  row.replaceChildren(input);
  row.draggable = false;
  input.focus();
  input.select();
  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    const next = cleanPdfProjectName(input.value);
    if (keep && next && next !== name) save(next);
    focusAfterRender = row.dataset.id ?? null;
    input.remove();
    renderProjects();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

/** Asks in the row itself (no browser dialog): `message`, then a confirm and a cancel button. */
export function confirmInRow(row: HTMLElement, message: string, confirmLabel: string, run: () => void): void {
  const box = el('div', { className: 'rpdf-li-confirm', role: 'alertdialog' });
  const text = el('p', { textContent: message });
  text.id = `rpdf-confirm-${Date.now()}`;
  box.setAttribute('aria-describedby', text.id);
  const yes = el('button', { type: 'button', className: 'rpdf-danger', textContent: confirmLabel });
  const no = el('button', { type: 'button', className: 'rpdf-style-text-btn', textContent: S.cancel });
  const buttons = el('div', { className: 'rpdf-li-confirm-buttons' });
  buttons.append(no, yes);
  box.append(text, buttons);
  row.replaceChildren(box);
  row.draggable = false;
  let done = false;
  const finish = (ok: boolean) => {
    if (done) return;
    done = true;
    focusAfterRender = row.dataset.id ?? null;
    box.remove();
    if (ok) run();
    renderProjects();
  };
  yes.addEventListener('click', () => finish(true));
  no.addEventListener('click', () => finish(false));
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } });
  box.addEventListener('focusout', (e) => { if (!box.contains(e.relatedTarget as Node | null)) finish(false); });
  no.focus();
}

export function projectListRow(id: string): HTMLElement | null {
  return Array.from(projectsItems.querySelectorAll<HTMLElement>('.rpdf-li')).find((row) => row.dataset.id === id) ?? null;
}

export function renderProjects(): void {
  if (rowBusy()) return;
  const index = membershipIndex();
  const { root, items } = pdfProjectTree(projects, folders);
  const collapsed = collapsedFolders();
  const rows: HTMLElement[] = [el('h3', { className: 'rpdf-li-head', textContent: S.projects }), projectRow(root, index, null)];
  for (const item of items) {
    if (item.kind === 'project') { rows.push(projectRow(item.project, index, null)); continue; }
    const shut = collapsed.has(item.folder.id);
    rows.push(folderRow(item.folder, item.projects.length, shut));
    if (!shut) rows.push(...item.projects.map((project) => projectRow(project, index, item.folder.id)));
  }
  // Dropping here puts a project or folder last, outside every folder.
  const end = el('div', { className: 'rpdf-li-end' });
  end.dataset.kind = 'end';
  wireListDrag(end);
  rows.push(end);
  projectsItems.replaceChildren(...rows);
  if (focusAfterRender) {
    projectListRow(focusAfterRender)?.querySelector<HTMLButtonElement>('.rpdf-li-main')?.focus();
    focusAfterRender = null;
  }
}

export function showProjectMenu(project: PdfProject, x: number, y: number): void {
  const inRow = (run: (row: HTMLElement) => void) => () => { const row = projectListRow(project.id); if (row) run(row); };
  const entries: MenuEntry[] = [
    { label: S.changeStyle, run: () => showStyle(project.id) },
    { label: S.rename, run: inRow((row) => startRename(row, project.name, S.projectNameLabel, (name) => { void sendRename({ kind: 'rename', id: project.id, name }); })) },
  ];
  if (project.id !== DEFAULT_PROJECT_ID) {
    const { items } = pdfProjectTree(projects, folders);
    const list = items.filter((item): item is Extract<typeof item, { kind: 'folder' }> => item.kind === 'folder');
    entries.push('sep', { heading: S.moveToFolderHeading });
    for (const item of list) {
      entries.push({ label: item.folder.name, disabled: project.folder === item.folder.id, run: () => placeItem({ kind: 'project', id: project.id }, item.folder.id, Infinity) });
    }
    if (project.folder && folders[project.folder]?.deletedAt === 0) {
      entries.push({ label: S.outOfFolder, run: () => placeAfterFolder(project.id, project.folder as string) });
    }
    entries.push({ label: S.newFolderWithProject, run: inRow((row) => startRename(row, '', S.newFolderPrompt, (name) => { void newFolderWith(project.id, name); })) });
    entries.push('sep', {
      label: S.delete,
      run: inRow((row) => confirmInRow(row, S.confirmDeleteProject(project.name), S.delete, () => {
        void sendProjectUpdate({ kind: 'delete', id: project.id }).then((response) => {
          if (!succeeded(response)) showToast(updateError(response, S.deleteFailed));
        });
      })),
    });
  }
  showMenu(entries, x, y);
}

export function sendRename(update: PdfProjectUpdate | PdfFolderUpdate): Promise<void> {
  return sendProjectUpdate(update).then((response) => {
    if (!succeeded(response)) showToast(updateError(response, S.renameFailed));
  });
}

export function showFolderMenu(folder: PdfProjectFolder, x: number, y: number): void {
  showMenu([
    {
      label: S.rename,
      run: () => {
        const row = projectListRow(folder.id);
        if (row) startRename(row, folder.name, S.folderNameLabel, (name) => { void sendRename({ kind: 'folder-rename', id: folder.id, name }); });
      },
    },
    { label: S.deleteFolder, run: () => { void deleteFolder(folder); } },
  ], x, y);
}

/** Deletes the folder (its projects stay, where it stood); undo makes it again with its projects in it. */
export async function deleteFolder(folder: PdfProjectFolder): Promise<void> {
  const inside = Object.values(projects)
    .filter((p) => p.deletedAt === 0 && p.folder === folder.id)
    .map((p) => ({ id: p.id, order: p.order }));
  const response = await sendProjectUpdate({ kind: 'folder-delete', id: folder.id });
  if (!succeeded(response)) { showToast(updateError(response, S.deleteFailed)); return; }
  showToast(S.folderDeleted(folder.name), {
    label: S.undo,
    run: () => {
      void (async () => {
        // A deleted folder stays a tombstone: the same name and place under a new id.
        const id = newPdfProjectFolderId();
        const created = await sendProjectUpdate({ kind: 'folder-create', id, name: folder.name, order: folder.order });
        if (!succeeded(created)) { showToast(updateError(created, S.folderCreateFailed)); return; }
        const keys = orderKeysBetween(null, null, inside.length);
        const placements = inside.map((p, i) => ({ id: p.id, folder: id, order: p.order ?? keys[i] }));
        if (placements.length) await sendProjectUpdate({ kind: 'arrange', projects: placements, folders: [] });
      })();
    },
  });
}

// ─── Folders and order ───

/** The items of one level (null: the top), in list order. */
export function siblingsOf(parent: string | null): Array<{ ref: ListRef; order: string | null }> {
  const { items } = pdfProjectTree(projects, folders);
  if (parent === null) {
    return items.map((item) => (item.kind === 'folder'
      ? { ref: { kind: 'folder' as const, id: item.folder.id }, order: item.folder.order }
      : { ref: { kind: 'project' as const, id: item.project.id }, order: item.project.order }));
  }
  const folder = items.find((item) => item.kind === 'folder' && item.folder.id === parent);
  return folder?.kind === 'folder' ? folder.projects.map((p) => ({ ref: { kind: 'project' as const, id: p.id }, order: p.order })) : [];
}

export const sameRef = (a: ListRef, b: ListRef) => a.kind === b.kind && a.id === b.id;

/**
 * Puts `ref` into `parent` (a folder, or null: the top) at `index` among the
 * items there other than itself. Only its own key changes, unless the level
 * still has unkeyed items: then the whole level gets keys, in the order shown.
 */
export function placeItem(ref: ListRef, parent: string | null, index: number): void {
  if (ref.kind === 'folder') parent = null;
  const siblings = siblingsOf(parent).filter((s) => !sameRef(s.ref, ref));
  const at = Math.max(0, Math.min(index, siblings.length));
  const before = at > 0 ? siblings[at - 1].order : null;
  const after = at < siblings.length ? siblings[at].order : null;
  const update: Extract<PdfFolderUpdate, { kind: 'arrange' }> = { kind: 'arrange', projects: [], folders: [] };
  const put = (item: ListRef, order: string) => {
    if (item.kind === 'project') update.projects.push({ id: item.id, folder: parent, order });
    else update.folders.push({ id: item.id, order });
  };
  const keyed = siblings.every((s) => s.order !== null) && (before === null || after === null || compareOrderKeys(before, after) < 0);
  if (keyed) {
    put(ref, orderKeyBetween(before, after));
  } else {
    const list = [...siblings.slice(0, at).map((s) => s.ref), ref, ...siblings.slice(at).map((s) => s.ref)];
    const keys = orderKeysBetween(null, null, list.length);
    list.forEach((item, i) => put(item, keys[i]));
  }
  focusAfterRender = ref.id;
  void sendProjectUpdate(update);
}

/** Out of its folder, right after it. */
export function placeAfterFolder(projectIdToMove: string, folderId: string): void {
  const top = siblingsOf(null);
  const at = top.findIndex((s) => s.ref.kind === 'folder' && s.ref.id === folderId);
  placeItem({ kind: 'project', id: projectIdToMove }, null, at + 1);
}

/** A key for a new item at the end of the top level, if the level is keyed. */
export function topEndKey(): string | null {
  const top = siblingsOf(null);
  if (top.some((s) => s.order === null)) return null;
  const last = top[top.length - 1]?.order ?? null;
  return orderKeyAtEnd(last);
}

export async function createFolder(rawName: string): Promise<string | null> {
  const name = cleanPdfProjectName(rawName);
  if (!name) return null;
  const id = newPdfProjectFolderId();
  const response = await sendProjectUpdate({ kind: 'folder-create', id, name, order: topEndKey() });
  if (!succeeded(response)) { showToast(updateError(response, S.folderCreateFailed)); return null; }
  return id;
}

export async function newFolderWith(id: string, name: string): Promise<void> {
  const folder = await createFolder(name);
  if (!folder) return;
  // The folder must be in storage (and read back here) before placing into it.
  setFoldersLocally({ ...folders, [folder]: { id: folder, name: cleanPdfProjectName(name) ?? '', createdAt: Date.now(), renamedAt: Date.now(), deletedAt: 0, order: null, placedAt: 0 } });
  placeItem({ kind: 'project', id }, folder, Infinity);
}

// Drag and drop: where a drop on `row` would put the dragged item.
export function dropPlace(row: HTMLElement, clientY: number): { parent: string | null; index: number; mark: 'before' | 'after' | 'into' } | null {
  const item = dragging;
  if (!item) return null;
  const kind = row.dataset.kind;
  const id = row.dataset.id ?? '';
  const parent = row.dataset.parent ? row.dataset.parent : null;
  const rect = row.getBoundingClientRect();
  const f = rect.height ? (clientY - rect.top) / rect.height : 0.5;
  const indexIn = (level: string | null, target: ListRef) => siblingsOf(level).filter((s) => !sameRef(s.ref, item)).findIndex((s) => sameRef(s.ref, target));
  if (kind === 'end') return { parent: null, index: Infinity, mark: 'before' };
  if (kind === 'root') return { parent: null, index: 0, mark: 'after' };
  if (kind === 'folder') {
    const target: ListRef = { kind: 'folder', id };
    if (sameRef(target, item)) return null;
    const at = indexIn(null, target);
    if (item.kind === 'folder') return f < 0.5 ? { parent: null, index: at, mark: 'before' } : { parent: null, index: at + 1, mark: 'after' };
    if (f < 0.3) return { parent: null, index: at, mark: 'before' };
    if (f > 0.75 && row.classList.contains('is-shut')) return { parent: null, index: at + 1, mark: 'after' };
    return { parent: id, index: Infinity, mark: 'into' };
  }
  if (kind === 'project') {
    const target: ListRef = { kind: 'project', id };
    if (sameRef(target, item)) return null;
    if (item.kind === 'folder' && parent !== null) return null;
    const at = indexIn(parent, target);
    return f < 0.5 ? { parent, index: at, mark: 'before' } : { parent, index: at + 1, mark: 'after' };
  }
  return null;
}

export function clearDropMarks(): void {
  for (const row of Array.from(projectsItems.querySelectorAll('.drop-before, .drop-after, .drop-into'))) row.classList.remove('drop-before', 'drop-after', 'drop-into');
}

export function wireListDrag(row: HTMLElement): void {
  const kind = row.dataset.kind;
  if (kind === 'project' || kind === 'folder') {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      dragging = { kind, id: row.dataset.id ?? '' };
      row.classList.add('is-dragging');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.dataset.id ?? ''); }
    });
    row.addEventListener('dragend', () => { dragging = null; row.classList.remove('is-dragging'); clearDropMarks(); });
  }
  row.addEventListener('dragover', (e) => {
    const place = dropPlace(row, e.clientY);
    clearDropMarks();
    if (!place) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    row.classList.add(`drop-${place.mark}`);
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after', 'drop-into'));
  row.addEventListener('drop', (e) => {
    const place = dropPlace(row, e.clientY);
    const item = dragging;
    clearDropMarks();
    if (!place || !item) return;
    e.preventDefault();
    dragging = null;
    placeItem(item, place.parent, place.index);
  });
}

// Alt+↑/↓: the focused project or folder one place up or down its level.
projectsItems.addEventListener('keydown', (e) => {
  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  const row = (e.target as HTMLElement).closest<HTMLElement>('.rpdf-li');
  const kind = row?.dataset.kind;
  if (!row || (kind !== 'project' && kind !== 'folder')) return;
  e.preventDefault();
  const ref: ListRef = { kind, id: row.dataset.id ?? '' };
  const parent = row.dataset.parent ? row.dataset.parent : null;
  const at = siblingsOf(parent).findIndex((s) => sameRef(s.ref, ref));
  const to = e.key === 'ArrowUp' ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= siblingsOf(parent).length) return;
  placeItem(ref, parent, to);
});

export function showProjects(): void {
  hidePanels();
  projectsPanel.hidden = false;
  projectBtn.setAttribute('aria-expanded', 'true');
  projectNewName.value = '';
  renderProjects();
  void loadOpenProjects().then(() => { if (!projectsPanel.hidden) renderProjects(); });
  projectsItems.querySelector<HTMLButtonElement>('.rpdf-li-main')?.focus();
}

export function hideProjects(): void {
  if (projectsPanel.hidden) return;
  projectsPanel.hidden = true;
  projectBtn.setAttribute('aria-expanded', 'false');
}
// The list's own menu (⋯, right click) belongs to it.
registerPopover(projectsPanel, [projectBtn, menu], hideProjects);

projectBtn.addEventListener('click', () => {
  if (!stylePanel.hidden) hideStyle();
  else if (projectsPanel.hidden) showProjects();
  else hideProjects();
});
folderNewBtn.addEventListener('click', () => {
  const name = projectNewName.value;
  if (!cleanPdfProjectName(name)) { projectNewName.focus(); showToast(S.folderNameNeeded); return; }
  void createFolder(name).then((id) => {
    if (!id) return;
    projectNewName.value = '';
    focusAfterRender = id;
  });
});
projectNewForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = projectNewName.value;
  void createProject(name).then((id) => {
    if (!id) return;
    hideProjects();
    void openProject(id);
  });
});
