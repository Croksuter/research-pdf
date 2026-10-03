// ─── Projects: named sets of documents, one hub each (pure) ───
//
// A project is what a hub tab holds: the documents registered to it
// (members), the ones pinned in it, and the tabs that were open when it was
// last seen (layout), so closing a project and opening it again brings back
// the same tabs. Every project is open in at most one hub; the registry in
// background/pdfHub.ts maps project → hub tab.
//
// The default project ("기본") is implicit: it holds every library document
// no other project has, so a document opened for the first time is in it
// without any write, and moving it to another project takes it out. Its rows
// here only carry pins. It cannot be deleted.
//
// Stored in chrome.storage.local (written by the background only, see
// background/pdfProjectStore.ts) and synced through Drive. The merge is a
// join: per project the latest rename wins the name, a deletion is final,
// per member the latest change wins, the latest saved layout wins. It can be
// applied over local rows at any time without losing a concurrent write.

import { PDF_HUB_MAX_DOCS, PDF_HUB_SHOW_HOME, isPdfViewerSourceUrl } from './localPdf';
import type { PdfLibraryEntry } from './pdfLibrary';

export const PDF_PROJECTS_STORAGE_KEY = 'rpdfProjects';
export const DEFAULT_PROJECT_ID = 'default';
export const DEFAULT_PROJECT_NAME = '기본';
export const PDF_PROJECTS_MAX = 200;
export const PDF_PROJECT_MAX_MEMBERS = 2_000;
export const PDF_PROJECT_NAME_MAX_CHARS = 60;
// Removed members and deleted projects are kept this long so a merge with a
// device that still has them cannot bring them back.
export const PDF_PROJECT_TOMBSTONE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const DOC_ID_MAX_CHARS = 128;
const PROJECT_ID_PATTERN = /^(?=.*[a-z_-])[a-z0-9_-]{1,40}$/u;

export interface PdfProjectMember {
  docId: string;
  /** Registered to the project. Ignored in the default project (see above). */
  member: boolean;
  pinned: boolean;
  /** Last change of either flag (0 = seeded): the latest change wins a merge. */
  changedAt: number;
}

/** The project's tabs when it was last open (URL-backed documents only). */
export interface PdfProjectLayout {
  urls: string[];
  active: number;
  /** `PDF_HUB_SHOW_HOME`, a pinned document's URL in front, or null. */
  show: string | null;
  savedAt: number;
}

export interface PdfProject {
  id: string;
  name: string;
  createdAt: number;
  renamedAt: number;
  /** When it was deleted (0 = live). Final: a deleted project stays deleted. */
  deletedAt: number;
  /** Sorted by `docId`. */
  members: PdfProjectMember[];
  layout: PdfProjectLayout;
}

export type PdfProjects = Record<string, PdfProject>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function time(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function isPdfProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID_PATTERN.test(value);
}

/** A fresh id: `p` + 12 base-36 characters. */
export function newPdfProjectId(random: () => number = Math.random): string {
  let id = 'p';
  for (let i = 0; i < 12; i += 1) id += Math.floor(random() * 36).toString(36);
  return id;
}

export function cleanPdfProjectName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/gu, ' ').trim().slice(0, PDF_PROJECT_NAME_MAX_CHARS);
  return name || null;
}

const EMPTY_LAYOUT: PdfProjectLayout = { urls: [], active: 0, show: null, savedAt: 0 };

function sourceOnly(url: unknown): string | null {
  if (typeof url !== 'string' || !isPdfViewerSourceUrl(url)) return null;
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href;
}

function parseLayout(value: unknown): PdfProjectLayout | null {
  if (!isRecord(value) || !Array.isArray(value.urls) || value.urls.length > PDF_HUB_MAX_DOCS) return null;
  const savedAt = time(value.savedAt);
  if (savedAt === null) return null;
  const urls: string[] = [];
  for (const raw of value.urls) {
    const url = sourceOnly(raw);
    if (!url) return null;
    if (!urls.includes(url)) urls.push(url);
  }
  const active = Number.isInteger(value.active) && (value.active as number) >= 0 && (value.active as number) < Math.max(1, urls.length) ? value.active as number : 0;
  const show = value.show === PDF_HUB_SHOW_HOME ? PDF_HUB_SHOW_HOME : value.show === null || value.show === undefined ? null : sourceOnly(value.show);
  return { urls, active, show, savedAt };
}

function parseMember(value: unknown): PdfProjectMember | null {
  if (!isRecord(value)) return null;
  const { docId } = value;
  const changedAt = time(value.changedAt);
  if (typeof docId !== 'string' || !docId || docId.length > DOC_ID_MAX_CHARS || changedAt === null) return null;
  if (typeof value.member !== 'boolean' || typeof value.pinned !== 'boolean') return null;
  return { docId, member: value.member, pinned: value.pinned, changedAt };
}

export function parsePdfProject(value: unknown): PdfProject | null {
  if (!isRecord(value) || !isPdfProjectId(value.id)) return null;
  const name = cleanPdfProjectName(value.name);
  const createdAt = time(value.createdAt);
  const renamedAt = time(value.renamedAt);
  const deletedAt = time(value.deletedAt);
  const layout = parseLayout(value.layout);
  if (!name || createdAt === null || renamedAt === null || deletedAt === null || !layout || !Array.isArray(value.members)) return null;
  if (value.members.length > PDF_PROJECT_MAX_MEMBERS) return null;
  const members: PdfProjectMember[] = [];
  const seen = new Set<string>();
  for (const raw of value.members) {
    const member = parseMember(raw);
    if (!member || seen.has(member.docId)) return null;
    seen.add(member.docId);
    members.push(member);
  }
  members.sort((a, b) => a.docId.localeCompare(b.docId));
  const isDefault = value.id === DEFAULT_PROJECT_ID;
  return { id: value.id, name, createdAt, renamedAt, deletedAt: isDefault ? 0 : deletedAt, members, layout };
}

/** Lenient map form (local storage): bad rows are dropped. */
export function parsePdfProjects(value: unknown): PdfProjects {
  const out: PdfProjects = {};
  if (isRecord(value)) {
    for (const [key, raw] of Object.entries(value)) {
      const project = parsePdfProject(raw);
      if (project && project.id === key) out[key] = project;
    }
  }
  return withDefaultProject(out);
}

/** Strict list form (sync snapshot): one bad row refuses the whole list. */
export function parsePdfProjectList(value: unknown): PdfProject[] | null {
  if (!Array.isArray(value) || value.length > PDF_PROJECTS_MAX * 2) return null;
  const seen = new Set<string>();
  const out: PdfProject[] = [];
  for (const raw of value) {
    const project = parsePdfProject(raw);
    if (!project || seen.has(project.id)) return null;
    seen.add(project.id);
    out.push(project);
  }
  return out;
}

export function emptyPdfProject(id: string, name: string, now: number): PdfProject {
  return { id, name, createdAt: now, renamedAt: id === DEFAULT_PROJECT_ID ? 0 : now, deletedAt: 0, members: [], layout: { ...EMPTY_LAYOUT } };
}

function withDefaultProject(projects: PdfProjects): PdfProjects {
  if (projects[DEFAULT_PROJECT_ID]) return projects;
  return { ...projects, [DEFAULT_PROJECT_ID]: emptyPdfProject(DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME, 0) };
}

/**
 * The first projects record on a device: the default project, holding the
 * pins the library carried before projects existed. Seeded with the pin's own
 * time, so two devices seeding the same library agree.
 */
export function seedPdfProjects(library: readonly PdfLibraryEntry[]): PdfProjects {
  const project = emptyPdfProject(DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME, 0);
  project.members = library
    .filter((e) => e.pinned)
    .map((e) => ({ docId: e.docId, member: true, pinned: true, changedAt: e.pinChangedAt }))
    .sort((a, b) => a.docId.localeCompare(b.docId));
  return { [DEFAULT_PROJECT_ID]: project };
}

// ─── Merge ───

function later<T>(a: T, b: T, key: (v: T) => number): T {
  const ka = key(a);
  const kb = key(b);
  if (ka !== kb) return ka > kb ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

/** Joins two copies of one project; commutative and idempotent. */
export function mergePdfProjects(a: PdfProject, b: PdfProject): PdfProject {
  const named = later(a, b, (p) => p.renamedAt);
  const deletedAt = a.id === DEFAULT_PROJECT_ID ? 0 : Math.max(a.deletedAt, b.deletedAt);
  const byDoc = new Map<string, PdfProjectMember>();
  for (const member of [...a.members, ...b.members]) {
    const existing = byDoc.get(member.docId);
    byDoc.set(member.docId, existing ? later(existing, member, (m) => m.changedAt) : member);
  }
  return {
    id: a.id,
    name: named.name,
    createdAt: Math.min(a.createdAt, b.createdAt),
    renamedAt: named.renamedAt,
    deletedAt,
    members: [...byDoc.values()].sort((x, y) => x.docId.localeCompare(y.docId)),
    layout: later(a.layout, b.layout, (l) => l.savedAt),
  };
}

/**
 * What every device keeps: live projects (the default first, then the most
 * recently created) up to the cap, deleted ones as bare tombstones for a
 * while; per project, registered and pinned rows first, then removals within
 * the age limit. Sorted by id.
 */
export function boundPdfProjects(projects: readonly PdfProject[], now: number = Date.now()): PdfProject[] {
  const live = projects
    .filter((p) => p.deletedAt === 0)
    .sort((a, b) => Number(b.id === DEFAULT_PROJECT_ID) - Number(a.id === DEFAULT_PROJECT_ID) || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, PDF_PROJECTS_MAX)
    .map((p) => {
      const kept = p.members.filter((m) => m.member || m.pinned);
      const removed = p.members
        .filter((m) => !m.member && !m.pinned && now - m.changedAt <= PDF_PROJECT_TOMBSTONE_MAX_AGE_MS)
        .sort((x, y) => y.changedAt - x.changedAt || x.docId.localeCompare(y.docId));
      const members = [...kept.sort((x, y) => y.changedAt - x.changedAt || x.docId.localeCompare(y.docId)), ...removed]
        .slice(0, PDF_PROJECT_MAX_MEMBERS)
        .sort((x, y) => x.docId.localeCompare(y.docId));
      return members.length === p.members.length ? p : { ...p, members };
    });
  const tombstones = projects
    .filter((p) => p.deletedAt > 0 && now - p.deletedAt <= PDF_PROJECT_TOMBSTONE_MAX_AGE_MS)
    .sort((a, b) => b.deletedAt - a.deletedAt || a.id.localeCompare(b.id))
    .slice(0, PDF_PROJECTS_MAX)
    .map((p) => ({ ...p, members: [], layout: { ...EMPTY_LAYOUT } }));
  return [...live, ...tombstones].sort((a, b) => a.id.localeCompare(b.id));
}

export function mergePdfProjectLists(left: readonly PdfProject[], right: readonly PdfProject[], now: number = Date.now()): PdfProject[] {
  const byId = new Map<string, PdfProject>();
  for (const project of [...left, ...right]) {
    const existing = byId.get(project.id);
    byId.set(project.id, existing ? mergePdfProjects(existing, project) : project);
  }
  return boundPdfProjects([...byId.values()], now);
}

export function pdfProjectsFromList(list: readonly PdfProject[]): PdfProjects {
  return withDefaultProject(Object.fromEntries(list.map((p) => [p.id, p])));
}

// ─── Updates (applied by the background's serialized writer) ───

export type PdfProjectUpdate =
  | { kind: 'create'; id: string; name: string }
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'delete'; id: string }
  // Register or remove a document. Removing also unpins it there.
  | { kind: 'member'; id: string; docId: string; member: boolean }
  // Pinning in a project also registers the document to it.
  | { kind: 'pin'; id: string; docId: string; pinned: boolean }
  // Out of `from` (unless it is the default project) and into `to`.
  | { kind: 'move'; docId: string; from: string; to: string }
  | { kind: 'layout'; id: string; urls: string[]; active: number; show: string | null };

function setMember(project: PdfProject, docId: string, change: (m: PdfProjectMember) => PdfProjectMember, now: number): PdfProject {
  const current = project.members.find((m) => m.docId === docId) ?? { docId, member: false, pinned: false, changedAt: 0 };
  const next = change(current);
  if (next.member === current.member && next.pinned === current.pinned) return project;
  const stamped = { ...next, changedAt: Math.max(now, current.changedAt + 1) };
  return {
    ...project,
    members: [...project.members.filter((m) => m.docId !== docId), stamped].sort((a, b) => a.docId.localeCompare(b.docId)),
  };
}

export function applyPdfProjectUpdate(projects: PdfProjects, update: PdfProjectUpdate, now: number = Date.now()): PdfProjects {
  const live = (id: string) => (projects[id] && projects[id].deletedAt === 0 ? projects[id] : null);
  const next: PdfProjects = { ...projects };
  switch (update.kind) {
    case 'create': {
      if (projects[update.id]) return projects;
      next[update.id] = emptyPdfProject(update.id, update.name, now);
      break;
    }
    case 'rename': {
      const project = live(update.id);
      if (!project || project.name === update.name) return projects;
      next[update.id] = { ...project, name: update.name, renamedAt: Math.max(now, project.renamedAt + 1) };
      break;
    }
    case 'delete': {
      const project = live(update.id);
      if (!project || update.id === DEFAULT_PROJECT_ID) return projects;
      next[update.id] = { ...project, deletedAt: Math.max(now, 1), members: [], layout: { ...EMPTY_LAYOUT } };
      break;
    }
    case 'member': {
      const project = live(update.id);
      if (!project || update.id === DEFAULT_PROJECT_ID) return projects;
      next[update.id] = setMember(project, update.docId, (m) => (update.member ? { ...m, member: true } : { ...m, member: false, pinned: false }), now);
      break;
    }
    case 'pin': {
      const project = live(update.id);
      if (!project) return projects;
      next[update.id] = setMember(project, update.docId, (m) => (update.pinned ? { ...m, member: true, pinned: true } : { ...m, pinned: false }), now);
      break;
    }
    case 'move': {
      const from = live(update.from);
      const to = live(update.to);
      if (!from || !to || update.from === update.to) return projects;
      next[update.from] = update.from === DEFAULT_PROJECT_ID
        ? setMember(from, update.docId, (m) => ({ ...m, pinned: false }), now)
        : setMember(from, update.docId, (m) => ({ ...m, member: false, pinned: false }), now);
      if (update.to !== DEFAULT_PROJECT_ID) next[update.to] = setMember(to, update.docId, (m) => ({ ...m, member: true }), now);
      break;
    }
    case 'layout': {
      const project = live(update.id);
      if (!project) return projects;
      const layout = parseLayout({ urls: update.urls, active: update.active, show: update.show, savedAt: Math.max(now, project.layout.savedAt + 1) });
      if (!layout) return projects;
      const same = layout.urls.join('\n') === project.layout.urls.join('\n') && layout.active === project.layout.active && layout.show === project.layout.show;
      if (same) return projects;
      next[update.id] = { ...project, layout };
      break;
    }
    default:
      return projects;
  }
  return pdfProjectsFromList(boundPdfProjects(Object.values(next), now));
}

/** Adds a URL to a closed project's tabs, so it is there when the project opens. */
export function appendToPdfProjectLayout(projects: PdfProjects, id: string, url: string, now: number = Date.now()): PdfProjects {
  const project = projects[id];
  const source = sourceOnly(url);
  if (!project || project.deletedAt !== 0 || !source || project.layout.urls.includes(source)) return projects;
  if (project.layout.urls.length >= PDF_HUB_MAX_DOCS) return projects;
  const urls = [...project.layout.urls, source];
  return applyPdfProjectUpdate(projects, { kind: 'layout', id, urls, active: urls.length - 1, show: null }, now);
}

export function parsePdfProjectUpdate(value: unknown): PdfProjectUpdate | null {
  if (!isRecord(value)) return null;
  const docIdOk = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= DOC_ID_MAX_CHARS;
  switch (value.kind) {
    case 'create':
    case 'rename': {
      const name = cleanPdfProjectName(value.name);
      if (!isPdfProjectId(value.id) || !name) return null;
      if (value.kind === 'create' && value.id === DEFAULT_PROJECT_ID) return null;
      return { kind: value.kind, id: value.id, name };
    }
    case 'delete':
      return isPdfProjectId(value.id) && value.id !== DEFAULT_PROJECT_ID ? { kind: 'delete', id: value.id } : null;
    case 'member':
      return isPdfProjectId(value.id) && docIdOk(value.docId) && typeof value.member === 'boolean'
        ? { kind: 'member', id: value.id, docId: value.docId, member: value.member } : null;
    case 'pin':
      return isPdfProjectId(value.id) && docIdOk(value.docId) && typeof value.pinned === 'boolean'
        ? { kind: 'pin', id: value.id, docId: value.docId, pinned: value.pinned } : null;
    case 'move':
      return docIdOk(value.docId) && isPdfProjectId(value.from) && isPdfProjectId(value.to)
        ? { kind: 'move', docId: value.docId, from: value.from, to: value.to } : null;
    case 'layout': {
      if (!isPdfProjectId(value.id)) return null;
      const layout = parseLayout({ urls: value.urls, active: value.active, show: value.show ?? null, savedAt: 0 });
      return layout ? { kind: 'layout', id: value.id, urls: layout.urls, active: layout.active, show: layout.show } : null;
    }
    default:
      return null;
  }
}

// ─── Queries ───

/** Live projects, the default first, then by name. */
export function livePdfProjects(projects: PdfProjects): PdfProject[] {
  return Object.values(projects)
    .filter((p) => p.deletedAt === 0)
    .sort((a, b) => Number(b.id === DEFAULT_PROJECT_ID) - Number(a.id === DEFAULT_PROJECT_ID) || a.name.localeCompare(b.name, 'ko') || a.id.localeCompare(b.id));
}

/** The live non-default projects a document is registered to. */
export function projectsOfDoc(projects: PdfProjects, docId: string): string[] {
  return livePdfProjects(projects)
    .filter((p) => p.id !== DEFAULT_PROJECT_ID && p.members.some((m) => m.docId === docId && m.member))
    .map((p) => p.id);
}

/** Whether `docId` is in the project: registered, or (default) in no other one. */
export function isDocInProject(projects: PdfProjects, projectId: string, docId: string): boolean {
  if (projectId === DEFAULT_PROJECT_ID) return projectsOfDoc(projects, docId).length === 0;
  const project = projects[projectId];
  return !!project && project.deletedAt === 0 && project.members.some((m) => m.docId === docId && m.member);
}

/** Documents pinned in the project, oldest pin first (the leftmost tab). */
export function projectPinnedDocIds(projects: PdfProjects, projectId: string): string[] {
  const project = projects[projectId];
  if (!project || project.deletedAt !== 0) return [];
  return project.members
    .filter((m) => m.pinned && isDocInProject(projects, projectId, m.docId))
    .sort((a, b) => a.changedAt - b.changedAt || a.docId.localeCompare(b.docId))
    .map((m) => m.docId);
}

/** Documents the library must keep because a project still refers to them. */
export function projectDocIds(projects: readonly PdfProject[]): Set<string> {
  const ids = new Set<string>();
  for (const project of projects) {
    if (project.deletedAt !== 0) continue;
    for (const m of project.members) if (m.member || m.pinned) ids.add(m.docId);
  }
  return ids;
}

/**
 * Where a document entering from the web goes: a project it is registered to
 * that is open right now, otherwise the default project.
 */
export function targetProjectForDoc(projects: PdfProjects, docId: string | null, isOpen: (projectId: string) => boolean): string {
  if (!docId) return DEFAULT_PROJECT_ID;
  return projectsOfDoc(projects, docId).find(isOpen) ?? DEFAULT_PROJECT_ID;
}
