// ─── "프로젝트로 이동": moving the document in front to another project ───

import { DEFAULT_PROJECT_ID, isDocInProject, pdfProjectTree, projectsOfDoc, type PdfProject } from '../../shared/pdfProjects';
import { S } from '../pdfHub.strings';
import { type HubTab, activeTab, ask, folders, libraryIdForUrl, loadOpenProjects, openProjectIds, pendingPins, projectId, projectName, projects, tabName, tabs } from './store';
import { moveBtn, moveItems, moveNewForm, moveNewName, movePanel, moveTitle } from './dom';
import { el, hidePanels, icon, iconButton, listRow, showToast, registerPopover } from './uiKit';
import { PENDING_TIMEOUT_MS, removeTab, render } from './tabStrip';
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
 * leaves it here). The background puts it in that project's hub, or among
 * the tabs it opens with.
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
  const from = moveSource(docId);
  const response = await ask<{ success?: boolean; open?: boolean; error?: string }>({
    type: 'VOCAB_T_PDF_PROJECT_MOVE', docId, url: tab.url, from, to, keep,
  });
  if (!response?.success) { showToast(response?.error ?? S.moveFailed); return; }
  const name = projectName(to);
  if (keep) { showToast(S.alsoAddedTo(name)); return; }
  pendingPins.delete(docId);
  if (tabs.includes(tab)) removeTab(tab);
  render();
  showToast(tab.url ? S.movedTo(name) : S.movedToLocal(name), {
    label: S.open,
    run: () => { void openProject(to); },
  });
}

/**
 * This hub's project was deleted: its documents go to the default project —
 * this hub becomes it, or hands them to its open hub and closes.
 */
