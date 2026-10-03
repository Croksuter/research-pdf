import { describe, expect, it } from 'vitest';

import type { PdfLibraryEntry } from '../src/shared/pdfLibrary';
import {
  DEFAULT_PROJECT_ID,
  PDF_PROJECT_TOMBSTONE_MAX_AGE_MS,
  appendToPdfProjectLayout,
  applyPdfProjectUpdate,
  boundPdfProjects,
  cleanPdfProjectName,
  isDocInProject,
  isPdfProjectId,
  mergePdfProjectLists,
  mergePdfProjects,
  newPdfProjectId,
  parsePdfProjectList,
  parsePdfProjectUpdate,
  parsePdfProjects,
  projectDocIds,
  projectPinnedDocIds,
  projectsOfDoc,
  seedPdfProjects,
  targetProjectForDoc,
  type PdfProject,
  type PdfProjects,
} from '../src/shared/pdfProjects';
import { parsePdfProjectMoveRequest, parsePdfProjectOpenRequest, parsePdfProjectUpdateRequest } from '../src/shared/messages';

const NOW = Date.UTC(2026, 9, 3);
const A = 'https://arxiv.org/pdf/2401.00001';
const B = 'https://a.org/b.pdf';

function libraryEntry(docId: string, pinned = false, pinChangedAt = 0): PdfLibraryEntry {
  return { docId, urls: [B], fileName: null, docTitle: null, title: null, venue: null, year: null, numPages: 3, openedAt: NOW - 1_000, pinned, pinChangedAt };
}

function project(id: string, overrides: Partial<PdfProject> = {}): PdfProject {
  return { id, name: id, createdAt: NOW - 10_000, renamedAt: NOW - 10_000, deletedAt: 0, members: [], layout: { urls: [], active: 0, show: null, savedAt: 0 }, ...overrides };
}

/** Default + one project `pa` holding d1 (pinned) and d2. */
function fixture(): PdfProjects {
  let projects = parsePdfProjects(undefined);
  projects = applyPdfProjectUpdate(projects, { kind: 'create', id: 'pa', name: 'Robotics' }, NOW);
  projects = applyPdfProjectUpdate(projects, { kind: 'member', id: 'pa', docId: 'd2', member: true }, NOW + 1);
  projects = applyPdfProjectUpdate(projects, { kind: 'pin', id: 'pa', docId: 'd1', pinned: true }, NOW + 2);
  return projects;
}

describe('projects', () => {
  it('always has the default project, seeded with the library\'s old pins', () => {
    expect(Object.keys(parsePdfProjects(undefined))).toEqual([DEFAULT_PROJECT_ID]);
    expect(Object.keys(parsePdfProjects({ junk: 1, pa: project('pa') }))).toEqual(['pa', DEFAULT_PROJECT_ID]);
    const seeded = seedPdfProjects([libraryEntry('d1', true, 50), libraryEntry('d2'), libraryEntry('d0', true, 20)]);
    expect(projectPinnedDocIds(seeded, DEFAULT_PROJECT_ID)).toEqual(['d0', 'd1']);
    // Two devices seeding the same library agree.
    expect(seedPdfProjects([libraryEntry('d1', true, 50)])).toEqual(seedPdfProjects([libraryEntry('d1', true, 50)]));
  });

  it('holds in the default project every document no other project has', () => {
    const projects = fixture();
    expect(isDocInProject(projects, 'pa', 'd1')).toBe(true);
    expect(isDocInProject(projects, DEFAULT_PROJECT_ID, 'd1')).toBe(false);
    expect(isDocInProject(projects, DEFAULT_PROJECT_ID, 'never-moved')).toBe(true);
    expect(isDocInProject(projects, 'pa', 'never-moved')).toBe(false);
    expect(projectsOfDoc(projects, 'd2')).toEqual(['pa']);
    expect(projectPinnedDocIds(projects, 'pa')).toEqual(['d1']);
    expect([...projectDocIds(Object.values(projects))].sort()).toEqual(['d1', 'd2']);
  });

  it('sends an entering document to an open project it belongs to, otherwise the default one', () => {
    const projects = fixture();
    expect(targetProjectForDoc(projects, 'd2', (id) => id === 'pa')).toBe('pa');
    expect(targetProjectForDoc(projects, 'd2', () => false)).toBe(DEFAULT_PROJECT_ID);
    expect(targetProjectForDoc(projects, 'other', () => true)).toBe(DEFAULT_PROJECT_ID);
    expect(targetProjectForDoc(projects, null, () => true)).toBe(DEFAULT_PROJECT_ID);
  });

  it('moves a document: out of its project (or the default one) and into another', () => {
    let projects = fixture();
    projects = applyPdfProjectUpdate(projects, { kind: 'create', id: 'pb', name: 'Vision' }, NOW + 3);
    // d1 was pinned in pa: moving it unpins it there.
    projects = applyPdfProjectUpdate(projects, { kind: 'move', docId: 'd1', from: 'pa', to: 'pb' }, NOW + 4);
    expect(projectsOfDoc(projects, 'd1')).toEqual(['pb']);
    expect(projectPinnedDocIds(projects, 'pa')).toEqual([]);
    // Into the default project: it is only taken out of the other one.
    projects = applyPdfProjectUpdate(projects, { kind: 'move', docId: 'd1', from: 'pb', to: DEFAULT_PROJECT_ID }, NOW + 5);
    expect(isDocInProject(projects, DEFAULT_PROJECT_ID, 'd1')).toBe(true);
    // Out of the default project: registered to the target.
    projects = applyPdfProjectUpdate(projects, { kind: 'move', docId: 'new', from: DEFAULT_PROJECT_ID, to: 'pb' }, NOW + 6);
    expect(isDocInProject(projects, 'pb', 'new')).toBe(true);
    expect(isDocInProject(projects, DEFAULT_PROJECT_ID, 'new')).toBe(false);
    // Nothing to do: the same object comes back.
    expect(applyPdfProjectUpdate(projects, { kind: 'move', docId: 'new', from: 'pb', to: 'pb' }, NOW + 7)).toBe(projects);
    expect(applyPdfProjectUpdate(projects, { kind: 'move', docId: 'new', from: 'pb', to: 'gone' }, NOW + 7)).toBe(projects);
  });

  it('renames, deletes (never the default project), and remembers the open tabs', () => {
    let projects = fixture();
    projects = applyPdfProjectUpdate(projects, { kind: 'rename', id: 'pa', name: 'Manipulation' }, NOW + 3);
    expect(projects.pa).toMatchObject({ name: 'Manipulation', renamedAt: NOW + 3 });
    expect(applyPdfProjectUpdate(projects, { kind: 'delete', id: DEFAULT_PROJECT_ID }, NOW + 4)).toBe(projects);
    projects = applyPdfProjectUpdate(projects, { kind: 'layout', id: 'pa', urls: [A, `${B}#page=2`], active: 1, show: 'home' }, NOW + 4);
    expect(projects.pa.layout).toEqual({ urls: [A, B], active: 1, show: 'home', savedAt: NOW + 4 });
    expect(applyPdfProjectUpdate(projects, { kind: 'layout', id: 'pa', urls: [A, B], active: 1, show: 'home' }, NOW + 5)).toBe(projects);
    expect(appendToPdfProjectLayout(projects, 'pa', `${A}#x`, NOW + 6)).toBe(projects);
    expect(appendToPdfProjectLayout(projects, 'pa', 'https://c.org/c.pdf', NOW + 6).pa.layout.urls).toEqual([A, B, 'https://c.org/c.pdf']);
    projects = applyPdfProjectUpdate(projects, { kind: 'delete', id: 'pa' }, NOW + 7);
    expect(projects.pa).toMatchObject({ deletedAt: NOW + 7, members: [] });
    // Its documents are back in the default project; it takes no more changes.
    expect(isDocInProject(projects, DEFAULT_PROJECT_ID, 'd2')).toBe(true);
    expect(applyPdfProjectUpdate(projects, { kind: 'rename', id: 'pa', name: 'Back' }, NOW + 8)).toBe(projects);
    expect(applyPdfProjectUpdate(projects, { kind: 'create', id: 'pa', name: 'Again' }, NOW + 8)).toBe(projects);
  });

  it('merges as a join: commutative, idempotent, deletions final, latest change per document', () => {
    const left = project('pa', { name: 'L', renamedAt: 5, members: [{ docId: 'd1', member: true, pinned: true, changedAt: 10 }] });
    const right = project('pa', {
      name: 'R', renamedAt: 7, deletedAt: 0,
      members: [{ docId: 'd1', member: false, pinned: false, changedAt: 20 }, { docId: 'd2', member: true, pinned: false, changedAt: 3 }],
      layout: { urls: [A], active: 0, show: null, savedAt: 9 },
    });
    const merged = mergePdfProjects(left, right);
    expect(merged).toEqual(mergePdfProjects(right, left));
    expect(mergePdfProjects(merged, merged)).toEqual(merged);
    expect(merged.name).toBe('R');
    expect(merged.members.map((m) => [m.docId, m.member])).toEqual([['d1', false], ['d2', true]]);
    expect(merged.layout.urls).toEqual([A]);
    const deleted = mergePdfProjects(merged, { ...left, deletedAt: 3 });
    expect(deleted.deletedAt).toBe(3);
    expect(mergePdfProjects({ ...project(DEFAULT_PROJECT_ID), deletedAt: 3 }, project(DEFAULT_PROJECT_ID)).deletedAt).toBe(0);
    const lists = mergePdfProjectLists([left], [right, project('pb')], NOW);
    expect(lists.map((p) => p.id)).toEqual(['pa', 'pb']);
  });

  it('bounds what every device keeps: deleted projects as bare tombstones for a while, removals aged out', () => {
    const old = NOW - PDF_PROJECT_TOMBSTONE_MAX_AGE_MS - 1;
    const bounded = boundPdfProjects([
      project('pa', { members: [{ docId: 'gone', member: false, pinned: false, changedAt: old }, { docId: 'kept', member: false, pinned: false, changedAt: NOW - 5 }, { docId: 'in', member: true, pinned: false, changedAt: old }] }),
      project('pb', { deletedAt: NOW - 5, members: [{ docId: 'x', member: true, pinned: false, changedAt: 1 }] }),
      project('pc', { deletedAt: old }),
    ], NOW);
    expect(bounded.map((p) => p.id)).toEqual(['pa', 'pb']);
    expect(bounded[0].members.map((m) => m.docId)).toEqual(['in', 'kept']);
    expect(bounded[1].members).toEqual([]);
  });

  it('parses stored and synced projects strictly by shape', () => {
    const good = project('pa', { members: [{ docId: 'd1', member: true, pinned: false, changedAt: 1 }], layout: { urls: [A], active: 0, show: 'home', savedAt: 2 } });
    expect(parsePdfProjectList([good])).toEqual([good]);
    expect(parsePdfProjectList([good, good])).toBeNull();
    expect(parsePdfProjectList([{ ...good, id: '123' }])).toBeNull(); // a bare number is not a project id
    expect(parsePdfProjectList([{ ...good, name: '   ' }])).toBeNull();
    expect(parsePdfProjectList([{ ...good, layout: { ...good.layout, urls: ['javascript:x'] } }])).toBeNull();
    expect(parsePdfProjectList([{ ...good, members: [{ docId: 'd1', member: 'yes', pinned: false, changedAt: 1 }] }])).toBeNull();
    expect(parsePdfProjects({ default: { ...project(DEFAULT_PROJECT_ID), deletedAt: 9 } }).default.deletedAt).toBe(0);
    expect(isPdfProjectId(newPdfProjectId())).toBe(true);
    expect(cleanPdfProjectName('  Robot   learning \n')).toBe('Robot learning');
    expect(cleanPdfProjectName('x'.repeat(100))).toHaveLength(60);
  });

  it('accepts only well-formed project messages from the hub', () => {
    expect(parsePdfProjectUpdate({ kind: 'create', id: 'pa', name: ' A ' })).toEqual({ kind: 'create', id: 'pa', name: 'A' });
    expect(parsePdfProjectUpdate({ kind: 'create', id: DEFAULT_PROJECT_ID, name: 'A' })).toBeNull();
    expect(parsePdfProjectUpdate({ kind: 'delete', id: DEFAULT_PROJECT_ID })).toBeNull();
    expect(parsePdfProjectUpdate({ kind: 'pin', id: 'pa', docId: 'd', pinned: 1 })).toBeNull();
    expect(parsePdfProjectUpdate({ kind: 'layout', id: 'pa', urls: [A], active: 0 })).toEqual({ kind: 'layout', id: 'pa', urls: [A], active: 0, show: null });
    // Layouts come with hub state reports and moves with their own message, not as updates.
    expect(parsePdfProjectUpdateRequest({ type: 'VOCAB_T_PDF_PROJECT_UPDATE', update: { kind: 'layout', id: 'pa', urls: [], active: 0 } })).toBeNull();
    expect(parsePdfProjectUpdateRequest({ type: 'VOCAB_T_PDF_PROJECT_UPDATE', update: { kind: 'member', id: 'pa', docId: 'd', member: true } }))
      .toEqual({ type: 'VOCAB_T_PDF_PROJECT_UPDATE', update: { kind: 'member', id: 'pa', docId: 'd', member: true } });
    expect(parsePdfProjectOpenRequest({ type: 'VOCAB_T_PDF_PROJECT_OPEN', project: 'pa', inPlace: true }))
      .toEqual({ type: 'VOCAB_T_PDF_PROJECT_OPEN', project: 'pa', inPlace: true });
    expect(parsePdfProjectOpenRequest({ type: 'VOCAB_T_PDF_PROJECT_OPEN', project: 'pa' })).toBeNull();
    expect(parsePdfProjectOpenRequest({ type: 'VOCAB_T_PDF_PROJECT_OPEN', project: 'p a', inPlace: false })).toBeNull();
    const move = { type: 'VOCAB_T_PDF_PROJECT_MOVE', docId: 'd', url: A, from: 'default', to: 'pa', keep: false };
    expect(parsePdfProjectMoveRequest(move)).toEqual(move);
    expect(parsePdfProjectMoveRequest({ ...move, url: null })).toEqual({ ...move, url: null });
    expect(parsePdfProjectMoveRequest({ ...move, to: 'default' })).toBeNull();
    expect(parsePdfProjectMoveRequest({ ...move, url: 'chrome://x' })).toBeNull();
  });
});
