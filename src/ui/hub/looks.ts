// ─── Looks: document kinds, project badges, the hub tab's favicon, the icon picker ───

import { DEFAULT_PROJECT_ID, PDF_PROJECT_COLORS, pdfProjectEmojiIcon, pdfProjectLook, type PdfProject, PDF_PROJECT_ICONS } from '../../shared/pdfProjects';
import { libraryEntryKind, type PdfDocKind } from '../../shared/pdfLibrary';
import { S } from '../pdfHub.strings';
import { currentProject, display, library, projectId, projects, reloadProjects, sendLibraryUpdate, sendProjectUpdate, succeeded, updateError, setProjectsLocally } from './store';
import { projectBtn, styleBack, styleColors, styleDone, styleEmojiInput, styleEmojis, styleIcons, stylePanel, stylePreview, styleReset, styleTitle } from './dom';
import { el, hidePanels, icon, showMenu, showToast, registerPopover } from './uiKit';
import { showProjects, updateProjectLabel } from './projectsPanel';

// ─── Looks: document kinds, project badges, the tab's icon ───

export const KIND_LABEL: Record<PdfDocKind, string> = {
  get journal() { return S.kindJournal; },
  get conference() { return S.kindConference; },
  get preprint() { return S.kindPreprint; },
  get survey() { return S.kindSurvey; },
  get technical() { return S.kindTechnical; },
  get document() { return S.kindDocument; },
};
export const KIND_ORDER: PdfDocKind[] = ['journal', 'conference', 'preprint', 'survey', 'technical', 'document'];

/** The document's kind: automatic (what the paper strip found), or one the user picks. */
export function showKindMenu(docId: string, x: number, y: number): void {
  const entry = library[docId];
  if (!entry) return;
  const set = (userKind: PdfDocKind | null) => { void sendLibraryUpdate({ kind: 'user-kind', docId, userKind }); };
  showMenu([
    { heading: S.kindMenuHeading },
    { label: S.kindAuto(KIND_LABEL[entry.paperKind ?? 'document']), checked: entry.userKind === null, run: () => set(null) },
    'sep',
    ...KIND_ORDER.map((kind) => ({ label: KIND_LABEL[kind], checked: entry.userKind === kind, run: () => set(kind) })),
  ], x, y);
}

export function docKind(docId: string | null): PdfDocKind {
  const entry = docId ? library[docId] : undefined;
  return entry ? libraryEntryKind(entry) : 'document';
}

export function kindIcon(kind: PdfDocKind, local: boolean): string {
  return kind === 'document' ? (local ? 'i-file-local' : 'i-file') : `i-kind-${kind}`;
}

/** Draws `project`'s icon, emoji or first letter into `badge`. */
export function fillBadge(badge: HTMLElement, project: PdfProject): void {
  const look = pdfProjectLook(project);
  badge.dataset.look = look.kind;
  badge.style.setProperty('--badge', look.color);
  badge.replaceChildren(look.kind === 'icon' ? icon(`i-proj-${look.value}`) : document.createTextNode(look.value));
}

export function projectBadge(project: PdfProject): HTMLSpanElement {
  const badge = el('span', { className: 'rpdf-pbadge' });
  badge.setAttribute('aria-hidden', 'true');
  fillBadge(badge, project);
  return badge;
}

// The hub tab's icon in Chrome is its project's, so hubs of different
// projects tell apart in the tab strip. The default project, never styled,
// keeps the app icon.
export const faviconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
export const APP_FAVICON = faviconLink?.getAttribute('href') ?? 'icons/icon-32.png';
export let faviconKey = '';

export function updateFavicon(): void {
  if (!faviconLink) return;
  const project = currentProject();
  const look = pdfProjectLook(project);
  const plain = !display.projectFavicon || (project.id === DEFAULT_PROJECT_ID && !project.icon && !project.color);
  const key = plain ? 'app' : `${look.kind}|${look.value}|${look.color}`;
  if (key === faviconKey) return;
  faviconKey = key;
  if (plain) { faviconLink.href = APP_FAVICON; return; }
  void drawFavicon(look).then((url) => { if (url && faviconKey === key) faviconLink.href = url; });
}

export async function drawFavicon(look: ReturnType<typeof pdfProjectLook>): Promise<string | null> {
  const size = 64;
  const canvas = el('canvas', { width: size, height: size });
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (look.kind === 'emoji') {
    ctx.font = `${Math.round(size * 0.84)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.fillText(look.value, size / 2, size * 0.55);
    return canvas.toDataURL('image/png');
  }
  ctx.fillStyle = look.color;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.22);
  ctx.fill();
  if (look.kind === 'letter') {
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.round(size * 0.6)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.fillText(look.value, size / 2, size * 0.55);
    return canvas.toDataURL('image/png');
  }
  const symbol = document.getElementById(`i-proj-${look.value}`);
  if (symbol) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${symbol.innerHTML}</svg>`;
    const image = new Image(size, size);
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    try {
      await image.decode();
      const inset = size * 0.16;
      ctx.drawImage(image, inset, inset, size - inset * 2, size - inset * 2);
    } catch {
      /* the colored square alone */
    }
  }
  return canvas.toDataURL('image/png');
}

// ─── Project icon picker ───

export const SUGGESTED_EMOJI = ['📚', '🧪', '🤖', '🧠', '💡', '🎯', '📈', '🧬', '🔭', '🌱', '⚙️', '📝', '🎓', '🗂️', '🔬', '🚀'];
export let styleTarget: string | null = null;

export function showStyle(id: string): void {
  hidePanels();
  styleTarget = id;
  stylePanel.hidden = false;
  projectBtn.setAttribute('aria-expanded', 'true');
  styleEmojiInput.value = '';
  renderStyle();
  styleIcons.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
}

export function hideStyle(): void {
  if (stylePanel.hidden) return;
  stylePanel.hidden = true;
  styleTarget = null;
  projectBtn.setAttribute('aria-expanded', 'false');
}
registerPopover(stylePanel, [projectBtn], hideStyle);

export function renderStyle(): void {
  const project = styleTarget ? projects[styleTarget] : undefined;
  if (!project || project.deletedAt !== 0) { hideStyle(); return; }
  fillBadge(stylePreview, project);
  styleTitle.textContent = project.name;
  const choice = (label: string, selected: boolean, content: Node | string, run: () => void, className = 'rpdf-style-choice') => {
    const button = el('button', { type: 'button', className, title: label });
    button.setAttribute('role', 'option');
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-selected', String(selected));
    button.append(content);
    button.addEventListener('click', run);
    return button;
  };
  styleIcons.replaceChildren(...PDF_PROJECT_ICONS.map((name) =>
    choice(name, project.icon === `i:${name}`, icon(`i-proj-${name}`), () => setStyle(project, `i:${name}`, project.color))));
  styleEmojis.replaceChildren(...SUGGESTED_EMOJI.map((emoji) =>
    choice(emoji, project.icon === `e:${emoji}`, emoji, () => setStyle(project, `e:${emoji}`, project.color))));
  const color = pdfProjectLook(project).color;
  styleColors.replaceChildren(...Object.entries(PDF_PROJECT_COLORS).map(([id, hex]) => {
    const swatch = choice(id, project.color === id || (!project.color && hex === color), '', () => setStyle(project, project.icon, id), 'rpdf-style-swatch');
    swatch.style.setProperty('--swatch', hex);
    return swatch;
  }));
}

/** Applies the look here at once; storage confirms it a moment later (or it is read back). */
export function setStyle(project: PdfProject, iconValue: string | null, color: string | null): void {
  void sendProjectUpdate({ kind: 'style', id: project.id, icon: iconValue, color }).then((response) => {
    if (succeeded(response)) return;
    showToast(updateError(response, S.styleFailed));
    void reloadProjects();
  });
  setProjectsLocally({ ...projects, [project.id]: { ...project, icon: iconValue, color } });
  if (project.id === projectId) updateProjectLabel();
  renderStyle();
}

styleBack.addEventListener('click', () => { hideStyle(); showProjects(); });
styleDone.addEventListener('click', () => { hideStyle(); projectBtn.focus(); });
styleReset.addEventListener('click', () => {
  const project = styleTarget ? projects[styleTarget] : undefined;
  if (project) setStyle(project, null, null);
});
export const takeEmoji = () => {
  const project = styleTarget ? projects[styleTarget] : undefined;
  const value = pdfProjectEmojiIcon(styleEmojiInput.value);
  if (!project || !styleEmojiInput.value.trim()) return;
  if (!value) { showToast(S.enterEmoji); return; }
  styleEmojiInput.value = '';
  setStyle(project, value, project.color);
};
styleEmojiInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); takeEmoji(); } });
styleEmojiInput.addEventListener('change', takeEmoji);
