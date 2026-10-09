// ─── ResearchPDF hub page ───
//
// One browser tab per project that collects its PDFs, so papers stop
// scattering across tabs that look like (and mix with) web pages. Each document is a viewer iframe (pdf-viewer.html) behind an
// in-page tab strip; iframes are created the first time a document is
// shown, so a restored hub with twenty papers loads only the one in front,
// and frames not shown for a while are unloaded again (shared/hubTabs.ts).
//
// A project (shared/pdfProjects.ts) is a named set of documents with its own
// pins and the tabs it was last closed with; every PDF first lands in the
// default project and "프로젝트로 이동" moves it. The switcher at the strip's
// left opens, creates, renames and deletes projects; each open project is
// one hub tab.
//
// Left of the tabs is the home page: the project's documents and pins, this
// hub's recently closed tabs, and the library of every document any hub has
// shown (shared/pdfLibrary.ts). Pinned documents are tabs in that project's
// hub, on every device.
//
// On load the page claims with the background (background/pdfHub.ts): it is
// either its project's hub, or it hands its documents to the existing hub
// and goes back to the page it came from (or closes). The document list lives in
// this page's own URL (history.replaceState, see shared/localPdf.ts), so a
// reload or Chrome's session restore brings every document back.

import { initDebugLogging } from '../shared/debugLog';
import { hubKeyAction } from '../shared/pdfHubProtocol';
import { localizeDocument } from '../shared/i18n';
import { S } from './pdfHub.strings';
import { isHub, on, projectId, projects, tabs } from './hub/store';
import { DEFAULT_PROJECT_ID } from '../shared/pdfProjects';
import { listBtn, listPanel, menu, moveBtn, movePanel, projectBtn, projectsPanel, stylePanel } from './hub/dom';
import { hideMenu } from './hub/uiKit';
import { completePendingPins, dropTabsThatLeft, onStripKey, reconcilePinned, step, updateTabLabel } from './hub/tabStrip';
import { boot, reloadInNewLanguage, rehome } from './hub/session';
import { hideList } from './hub/tabList';
import { hideStyle, renderStyle, updateFavicon } from './hub/looks';
import { hideProjects, renderProjects, updateProjectLabel } from './hub/projectsPanel';
import { hideMove, moveTarget, renderMove, takeMoveNotice } from './hub/movePanel';
import { claimHandedOver } from './hub/localFiles';
import { onPositionsChanged, scheduleHomeRender } from './hub/home/home';

// The page's modules (src/ui/hub/):
//   store          state, storage → change events, background requests
//   uiKit, dom     elements, rows, the menu, the toast, popovers
//   tabStrip       tabs, pins, drag, keyboard, what is in front
//   frames         viewer frames: load, sleep, messages, upkeep
//   session        URL and saved layout, recently closed, switching, boot
//   localFiles     files opened from disk, kept for the session
//   tabList        the ▾ list of every tab
//   home/*         home: rows, selection, gathering
//   projectsPanel, movePanel, looks

localizeDocument(S);

initDebugLogging();

function refreshPanels(): void {
  if (!projectsPanel.hidden) renderProjects();
  if (!stylePanel.hidden) renderStyle();
  if (!movePanel.hidden && moveTarget) renderMove(moveTarget);
}

// ─── What changed elsewhere (the store's events) ───

// This project's documents as last seen, to tell which left it. The default
// project is left out: its membership is implicit, and it shows guests.
let members: { project: string; ids: Set<string> } | null = null;
function memberIds(): Set<string> {
  return new Set((projects[projectId]?.members ?? []).filter((m) => m.member).map((m) => m.docId));
}

on('data', ({ library, projects: projectsChanged }) => {
  if (library) tabs.forEach(updateTabLabel); // kinds
  if (isHub) {
    // This project was deleted (here, in another hub, on another device).
    if (projects[projectId]?.deletedAt !== 0) { void rehome(); return; }
    if (projectsChanged) {
      const now = memberIds();
      if (members?.project === projectId && projectId !== DEFAULT_PROJECT_ID) dropTabsThatLeft(members.ids, now);
      members = { project: projectId, ids: now };
    }
    completePendingPins();
    reconcilePinned();
    updateProjectLabel();
    refreshPanels();
  }
  scheduleHomeRender();
});
// Any viewer in any window saving where it is: only what home shows of it matters.
on('positions', onPositionsChanged);
on('registry', refreshPanels);
on('display', () => {
  tabs.forEach(updateTabLabel);
  updateFavicon();
  scheduleHomeRender();
});
on('language', reloadInNewLanguage);

document.addEventListener('keydown', (e) => {
  const action = hubKeyAction(e);
  if (action) { e.preventDefault(); step(action); return; }
  if (e.key === 'Escape') {
    if (!menu.hidden) { hideMenu(); return; }
    if (!listPanel.hidden) { hideList(); listBtn.focus(); return; }
    if (!projectsPanel.hidden) { hideProjects(); projectBtn.focus(); return; }
    if (!stylePanel.hidden) { hideStyle(); projectBtn.focus(); return; }
    if (!movePanel.hidden) { hideMove(); moveBtn.focus(); return; }
  }
  const focused = (document.activeElement as Element | null)?.closest<HTMLElement>('.rpdf-tab');
  const tab = focused ? tabs.find((t) => t.root === focused) : undefined;
  if (tab && onStripKey(e, tab)) e.preventDefault();
});

void boot().then(async () => {
  if (!isHub) return;
  members = { project: projectId, ids: memberIds() };
  // Local files and a note handed over by a move to this project.
  await claimHandedOver();
  await takeMoveNotice();
});
