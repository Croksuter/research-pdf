// ─── The ▾ list: every tab, the project's closed documents, recently closed ───

import { relativeTime } from '../../shared/pdfLibrary';
import { S } from '../pdfHub.strings';
import { activeKey, currentProject, entryName, inThisProject, isLocal, library, membershipIndex, tabName, tabs } from './store';
import { listBtn, listItems, listPanel, listSearch } from './dom';
import { el, hidePanels, icon, iconButton, listRow, registerPopover } from './uiKit';
import { activate, closeTab } from './tabStrip';
import { closed, reopenClosed } from './session';
import { openEntry } from './home/home';

export function renderList(): void {
  const words = listSearch.value.toLowerCase().split(/\s+/u).filter(Boolean);
  const matches = (...fields: Array<string | null>) => {
    const hay = fields.filter(Boolean).join('\n').toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  listItems.replaceChildren();
  const open = tabs.filter((t) => matches(t.title, t.paperTitle, t.url));
  for (const tab of open) {
    const row = listRow({
      icon: icon(tab.pinned ? 'i-pin' : isLocal(tab) ? 'i-file-local' : 'i-file'),
      title: tabName(tab),
      sub: tab.paperTitle && tab.title !== tab.paperTitle ? tab.title : null,
      onClick: () => { hideList(); activate(tab.key); },
      actions: tab.pinned ? [] : [iconButton('i-close', S.close, S.closeAria(tabName(tab)), () => { closeTab(tab.key); renderList(); })],
    });
    row.classList.toggle('is-active', tab.key === activeKey);
    listItems.append(row);
  }
  if (open.length === 0) listItems.append(el('p', { className: 'rpdf-li-empty', textContent: words.length ? S.noMatchingTab : S.noOpenTabs }));
  // The project's documents that are not open: one click away.
  const index = membershipIndex();
  const openIds = new Set(tabs.map((t) => t.docId ?? t.libraryId));
  const members = Object.values(library)
    .filter((e) => e.urls.length > 0 && !openIds.has(e.docId) && inThisProject(e.docId, index) && matches(entryName(e), e.fileName, ...e.urls))
    .sort((a, b) => b.openedAt - a.openedAt);
  if (members.length) {
    listItems.append(el('h3', { className: 'rpdf-li-head', textContent: S.closedDocsOf(currentProject().name) }));
    for (const entry of members.slice(0, 10)) {
      listItems.append(listRow({
        icon: icon(entry.urls[0].startsWith('file:') ? 'i-file-local' : 'i-file'),
        title: entryName(entry),
        sub: S.openedAgo(relativeTime(entry.openedAt)),
        onClick: () => { hideList(); openEntry(entry); },
      }));
    }
  }
  const recent = closed.filter((e) => matches(e.title, e.paperTitle, e.url));
  if (recent.length) {
    listItems.append(el('h3', { className: 'rpdf-li-head', textContent: S.recentlyClosed }));
    for (const entry of recent.slice(0, 10)) {
      listItems.append(listRow({
        icon: icon('i-restore'),
        title: entry.paperTitle ?? entry.title,
        sub: S.closedAgo(relativeTime(entry.closedAt)),
        onClick: () => { hideList(); reopenClosed(entry); },
      }));
    }
  }
}

export function showList(): void {
  hidePanels();
  listPanel.hidden = false;
  listBtn.setAttribute('aria-expanded', 'true');
  listSearch.value = '';
  renderList();
  listSearch.focus();
}

export function hideList(): void {
  if (listPanel.hidden) return;
  listPanel.hidden = true;
  listBtn.setAttribute('aria-expanded', 'false');
}
registerPopover(listPanel, [listBtn], hideList);

listBtn.addEventListener('click', () => { if (listPanel.hidden) showList(); else hideList(); });
listSearch.addEventListener('input', renderList);
listPanel.addEventListener('keydown', (e) => {
  const items = Array.from(listItems.querySelectorAll<HTMLButtonElement>('.rpdf-li-main'));
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? index + 1 : index <= 0 ? -1 : index - 1;
    if (next < 0) listSearch.focus();
    else items[Math.min(next, items.length - 1)]?.focus();
  } else if (e.key === 'Enter' && document.activeElement === listSearch) {
    e.preventDefault();
    items[0]?.click();
  }
});
