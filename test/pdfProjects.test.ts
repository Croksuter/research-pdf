import { noUserFields } from '../src/shared/pdfLibrary';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PdfLibraryEntry } from '../src/shared/pdfLibrary';
import {
  DEFAULT_PROJECT_ID,
  PDF_PROJECTS_MAX,
  PDF_PROJECT_FOLDERS_MAX,
  PDF_PROJECT_MAX_MEMBERS,
  PDF_PROJECT_TOMBSTONE_MAX_AGE_MS,
  boundPdfProjectFolders,
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
  PDF_PROJECT_COLORS,
  applyPdfFolderUpdate,
  mergePdfProjectFolderLists,
  parsePdfFolderUpdate,
  pdfProjectEmojiIcon,
  pdfProjectLook,
  pdfProjectTree,
  type PdfProject,
  type PdfProjectFolder,
  type PdfProjectState,
  type PdfProjects,
} from '../src/shared/pdfProjects';
import { parsePdfProjectMoveRequest, parsePdfProjectOpenRequest, parsePdfProjectUpdateRequest } from '../src/shared/messages';
import { ORDER_KEY_MAX_CHARS, compareOrderKeys, isOrderKey, orderKeyBetween, orderKeysBetween } from '../src/shared/orderKey';

const NOW = Date.UTC(2026, 9, 3);
const A = 'https://arxiv.org/pdf/2401.00001';
const B = 'https://a.org/b.pdf';

function libraryEntry(docId: string, pinned = false, pinChangedAt = 0): PdfLibraryEntry {
  return { docId, urls: [B], fileName: null, docTitle: null, title: null, venue: null, year: null, numPages: 3, openedAt: NOW - 1_000, pinned, pinChangedAt, paperKind: null, userKind: null, userKindAt: 0, ...noUserFields() };
}

function project(id: string, overrides: Partial<PdfProject> = {}): PdfProject {
  return { id, name: id, createdAt: NOW - 10_000, renamedAt: NOW - 10_000, deletedAt: 0, members: [], layout: { urls: [], active: 0, show: null, savedAt: 0 },
    icon: null, color: null, styledAt: 0, folder: null, order: null, placedAt: 0, ...overrides };
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
    const left = project('pa', { name: 'L', renamedAt: 5, members: [{ docId: 'd1', member: true, pinned: true, changedAt: 10 , pinOrder: null}] });
    const right = project('pa', {
      name: 'R', renamedAt: 7, deletedAt: 0,
      members: [{ docId: 'd1', member: false, pinned: false, changedAt: 20 , pinOrder: null}, { docId: 'd2', member: true, pinned: false, changedAt: 3 , pinOrder: null}],
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
      project('pa', { members: [{ docId: 'gone', member: false, pinned: false, changedAt: old , pinOrder: null}, { docId: 'kept', member: false, pinned: false, changedAt: NOW - 5 , pinOrder: null}, { docId: 'in', member: true, pinned: false, changedAt: old , pinOrder: null}] }),
      project('pb', { deletedAt: NOW - 5, members: [{ docId: 'x', member: true, pinned: false, changedAt: 1 , pinOrder: null}] }),
      project('pc', { deletedAt: old }),
    ], NOW);
    expect(bounded.map((p) => p.id)).toEqual(['pa', 'pb']);
    expect(bounded[0].members.map((m) => m.docId)).toEqual(['in', 'kept']);
    expect(bounded[1].members).toEqual([]);
  });

  it('parses stored and synced projects strictly by shape', () => {
    const good = project('pa', { members: [{ docId: 'd1', member: true, pinned: false, pinOrder: null, changedAt: 1 }], layout: { urls: [A], active: 0, show: 'home', savedAt: 2 } });
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

describe('project looks', () => {
  it('draws a project with its icon, emoji or first letter, on its color', () => {
    expect(pdfProjectLook(project('pa', { name: 'robotics', icon: 'i:robot', color: 'teal' }))).toEqual({ kind: 'icon', value: 'robot', color: PDF_PROJECT_COLORS.teal });
    expect(pdfProjectLook(project('pa', { name: 'x', icon: 'e:🤖' }))).toMatchObject({ kind: 'emoji', value: '🤖' });
    expect(pdfProjectLook(project('pa', { name: '  로보틱스' }))).toMatchObject({ kind: 'letter', value: '로' });
    // An icon a newer build knows falls back to the letter; a color likewise to the id's.
    expect(pdfProjectLook(project('pa', { name: 'abc', icon: 'i:hologram', color: 'ultraviolet' }))).toEqual(pdfProjectLook(project('pa', { name: 'abc' })));
  });

  it('takes one emoji from typed text', () => {
    expect(pdfProjectEmojiIcon(' 🧪 ')).toBe('e:🧪');
    expect(pdfProjectEmojiIcon('👩🏽‍🔬 lab')).toBe('e:👩🏽‍🔬');
    expect(pdfProjectEmojiIcon('🇰🇷')).toBe('e:🇰🇷');
    expect(pdfProjectEmojiIcon('a')).toBeNull();
    expect(pdfProjectEmojiIcon('')).toBeNull();
  });

  it('styles a project; the latest look wins a merge', () => {
    let projects: PdfProjects = { pa: project('pa') };
    projects = applyPdfProjectUpdate(projects, { kind: 'style', id: 'pa', icon: 'i:flask', color: 'red' }, NOW);
    expect(projects.pa).toMatchObject({ icon: 'i:flask', color: 'red', styledAt: NOW });
    const other = project('pa', { icon: 'e:🧪', color: null, styledAt: NOW + 5 });
    expect(mergePdfProjects(projects.pa, other)).toMatchObject({ icon: 'e:🧪', color: null, styledAt: NOW + 5 });
    expect(mergePdfProjects(other, projects.pa)).toEqual(mergePdfProjects(projects.pa, other));
    expect(parsePdfProjectUpdate({ kind: 'style', id: 'pa', icon: 'i:flask', color: 'nope' })).toBeNull();
    expect(parsePdfProjectUpdate({ kind: 'style', id: 'pa', icon: 'javascript:x', color: null })).toBeNull();
    expect(parsePdfProjectUpdate({ kind: 'style', id: 'pa', icon: null, color: null })).toEqual({ kind: 'style', id: 'pa', icon: null, color: null });
  });
});

describe('project folders and order', () => {
  const folder = (id: string, overrides: Partial<PdfProjectFolder> = {}): PdfProjectFolder => ({
    id, name: id, createdAt: NOW - 10_000, renamedAt: NOW - 10_000, deletedAt: 0, order: null, placedAt: 0, ...overrides,
  });
  const names = (state: PdfProjectState) => {
    const { root, items } = pdfProjectTree(state.projects, state.folders);
    return [root.id, ...items.map((item) => (item.kind === 'folder' ? `${item.folder.id}[${item.projects.map((p) => p.id).join(',')}]` : item.project.id))];
  };

  it('lists the default project first, then folders and projects by key, unkeyed ones by name', () => {
    const state: PdfProjectState = {
      projects: {
        default: project('default'),
        pz: project('pz', { name: 'Zeta' }),
        pa: project('pa', { name: 'Alpha' }),
        pk: project('pk', { order: '5' }),
        pi: project('pi', { folder: 'f1', order: '2' }),
        pj: project('pj', { folder: 'f1', order: '1' }),
        po: project('po', { folder: 'fgone', order: '1' }),
      },
      folders: { f1: folder('f1', { order: '3' }), fgone: folder('fgone', { deletedAt: NOW }) },
    };
    expect(names(state)).toEqual(['default', 'po', 'f1[pj,pi]', 'pk', 'pa', 'pz']);
  });

  it('creates, arranges and deletes folders; a deleted folder lets its projects out where it stood', () => {
    let state: PdfProjectState = {
      projects: { default: project('default'), pa: project('pa', { order: '1' }), pb: project('pb', { order: '3' }), pc: project('pc', { order: '5' }) },
      folders: {},
    };
    state = applyPdfFolderUpdate(state, { kind: 'folder-create', id: 'f1', name: 'Lab', order: '2' }, NOW);
    state = applyPdfFolderUpdate(state, { kind: 'arrange', projects: [{ id: 'pc', folder: 'f1', order: '1' }, { id: 'pb', folder: 'f1', order: '2' }], folders: [] }, NOW + 1);
    expect(names(state)).toEqual(['default', 'pa', 'f1[pc,pb]']);
    // The default project and unknown folders are not placed.
    const same = applyPdfFolderUpdate(state, { kind: 'arrange', projects: [{ id: 'default', folder: null, order: '9' }, { id: 'pa', folder: 'nope', order: '9' }], folders: [] }, NOW + 2);
    expect(same).toBe(state);
    state = applyPdfFolderUpdate(state, { kind: 'folder-rename', id: 'f1', name: 'Lab 2' }, NOW + 3);
    expect(state.folders.f1.name).toBe('Lab 2');
    state = applyPdfFolderUpdate(state, { kind: 'folder-delete', id: 'f1' }, NOW + 4);
    expect(state.folders.f1.deletedAt).toBe(NOW + 4);
    expect(names(state)).toEqual(['default', 'pa', 'pc', 'pb']);
    expect(state.projects.pc.folder).toBeNull();
  });

  it('merges placement and folders: latest wins, deletion is final', () => {
    const a = project('pa', { folder: 'f1', order: '1', placedAt: NOW });
    const b = project('pa', { folder: null, order: '7', placedAt: NOW + 1 });
    expect(mergePdfProjects(a, b)).toMatchObject({ folder: null, order: '7', placedAt: NOW + 1 });
    const merged = mergePdfProjectFolderLists(
      [folder('f1', { name: 'old', renamedAt: 1, order: '2', placedAt: 5 })],
      [folder('f1', { name: 'new', renamedAt: 2, deletedAt: NOW, order: '1', placedAt: 3 })],
      NOW,
    );
    expect(merged).toEqual([folder('f1', { name: 'new', renamedAt: 2, deletedAt: NOW, order: '2', placedAt: 5 })]);
  });

  it('parses folder updates strictly', () => {
    expect(parsePdfFolderUpdate({ kind: 'folder-create', id: 'f1', name: ' Lab ', order: null })).toEqual({ kind: 'folder-create', id: 'f1', name: 'Lab', order: null });
    expect(parsePdfFolderUpdate({ kind: 'folder-create', id: 'default', name: 'x', order: null })).toBeNull();
    expect(parsePdfFolderUpdate({ kind: 'arrange', projects: [{ id: 'pa', folder: null, order: 'a0' }], folders: [] })).toBeNull();
    expect(parsePdfFolderUpdate({ kind: 'arrange', projects: [{ id: 'pa', folder: 'f1', order: 'a' }], folders: [{ id: 'f1', order: 'b' }] }))
      .toEqual({ kind: 'arrange', projects: [{ id: 'pa', folder: 'f1', order: 'a' }], folders: [{ id: 'f1', order: 'b' }] });
    expect(parsePdfProjectUpdateRequest({ type: 'VOCAB_T_PDF_PROJECT_UPDATE', update: { kind: 'folder-delete', id: 'f1' } }))
      .toEqual({ type: 'VOCAB_T_PDF_PROJECT_UPDATE', update: { kind: 'folder-delete', id: 'f1' } });
  });
});

describe('pin order', () => {
  it('orders pins by their keys, unplaced ones after by pin time, and forgets the place on unpin', () => {
    let projects: PdfProjects = { default: project('default'), pa: project('pa') };
    for (const [docId, t] of [['d1', 1], ['d2', 2], ['d3', 3]] as const) {
      projects = applyPdfProjectUpdate(projects, { kind: 'pin', id: 'pa', docId, pinned: true }, NOW + t);
    }
    expect(projectPinnedDocIds(projects, 'pa')).toEqual(['d1', 'd2', 'd3']);
    projects = applyPdfProjectUpdate(projects, { kind: 'pin-order', id: 'pa', order: [{ docId: 'd3', order: '1' }, { docId: 'd1', order: '2' }] }, NOW + 10);
    expect(projectPinnedDocIds(projects, 'pa')).toEqual(['d3', 'd1', 'd2']);
    // Not pinned: no place to take.
    const same = applyPdfProjectUpdate(projects, { kind: 'pin-order', id: 'pa', order: [{ docId: 'zz', order: '0V' }] }, NOW + 11);
    expect(same).toBe(projects);
    projects = applyPdfProjectUpdate(projects, { kind: 'pin', id: 'pa', docId: 'd3', pinned: false }, NOW + 12);
    expect(projects.pa.members.find((m) => m.docId === 'd3')?.pinOrder).toBeNull();
    expect(projectPinnedDocIds(projects, 'pa')).toEqual(['d1', 'd2']);
    expect(parsePdfProjectUpdate({ kind: 'pin-order', id: 'pa', order: [{ docId: 'd1', order: 'a0' }] })).toBeNull();
    expect(parsePdfProjectUpdateRequest({ type: 'VOCAB_T_PDF_PROJECT_UPDATE', update: { kind: 'pin-order', id: 'pa', order: [{ docId: 'd1', order: 'a' }] } }))
      .toEqual({ type: 'VOCAB_T_PDF_PROJECT_UPDATE', update: { kind: 'pin-order', id: 'pa', order: [{ docId: 'd1', order: 'a' }] } });
  });
});

describe('caps', () => {
  const folder = (id: string, overrides: Partial<PdfProjectFolder> = {}): PdfProjectFolder => ({
    id, name: id, createdAt: NOW - 10_000, renamedAt: NOW - 10_000, deletedAt: 0, order: null, placedAt: 0, ...overrides,
  });
  const many = (n: number, prefix = 'p') => Array.from({ length: n }, (_, i) => project(`${prefix}${String(i).padStart(4, '0')}x`, { createdAt: NOW - i }));

  it('never drops a live project, folder or registered document to meet a cap; only tombstones and removals are capped', () => {
    // Two devices that each made projects offline: more than the cap after the merge.
    const live = many(PDF_PROJECTS_MAX + 50);
    const tombstones = many(PDF_PROJECTS_MAX + 10, 'd').map((p, i) => ({ ...p, deletedAt: NOW - i - 1 }));
    const bounded = boundPdfProjects([project(DEFAULT_PROJECT_ID), ...live, ...tombstones], NOW);
    expect(bounded.filter((p) => p.deletedAt === 0)).toHaveLength(PDF_PROJECTS_MAX + 51);
    expect(bounded.filter((p) => p.deletedAt > 0)).toHaveLength(PDF_PROJECTS_MAX);
    // The oldest project is still there, on every device: the merged list parses back whole.
    expect(parsePdfProjectList(bounded)).toHaveLength(bounded.length);

    const members = Array.from({ length: PDF_PROJECT_MAX_MEMBERS + 100 }, (_, i) => ({ docId: `in${i}`, member: true, pinned: false, pinOrder: null, changedAt: NOW - i }));
    const removed = Array.from({ length: 50 }, (_, i) => ({ docId: `out${i}`, member: false, pinned: false, pinOrder: null, changedAt: NOW - i }));
    const [big] = boundPdfProjects([project('pa', { members: [...members, ...removed] })], NOW);
    expect(big.members).toHaveLength(PDF_PROJECT_MAX_MEMBERS + 100);
    expect(big.members.every((m) => m.member)).toBe(true);
    expect(parsePdfProjects({ pa: big }).pa.members).toHaveLength(PDF_PROJECT_MAX_MEMBERS + 100);

    const folders = Array.from({ length: PDF_PROJECT_FOLDERS_MAX + 20 }, (_, i) => folder(`f${i}x`, { createdAt: NOW - i }));
    expect(boundPdfProjectFolders(folders, NOW)).toHaveLength(PDF_PROJECT_FOLDERS_MAX + 20);
  });

  it('refuses to create a project or a folder at the cap', () => {
    let projects: PdfProjects = { default: project(DEFAULT_PROJECT_ID) };
    for (const p of many(PDF_PROJECTS_MAX - 1)) projects[p.id] = p;
    projects = { ...projects };
    expect(applyPdfProjectUpdate(projects, { kind: 'create', id: 'pnew', name: 'New' }, NOW)).toBe(projects);
    // A deleted one makes room.
    const deleted = applyPdfProjectUpdate(projects, { kind: 'delete', id: 'p0000x' }, NOW);
    expect(applyPdfProjectUpdate(deleted, { kind: 'create', id: 'pnew', name: 'New' }, NOW).pnew).toBeDefined();

    const folders = Object.fromEntries(Array.from({ length: PDF_PROJECT_FOLDERS_MAX }, (_, i) => [`f${i}x`, folder(`f${i}x`)]));
    const state: PdfProjectState = { projects: { default: project(DEFAULT_PROJECT_ID) }, folders };
    expect(applyPdfFolderUpdate(state, { kind: 'folder-create', id: 'fnew', name: 'New', order: null }, NOW)).toBe(state);
  });
});

describe('the background\'s project writer at a cap', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('answers which cap refused a create, and still applies everything else', async () => {
    const local: Record<string, unknown> = {};
    vi.stubGlobal('chrome', { storage: { local: {
      get: async (key: string) => (key in local ? { [key]: structuredClone(local[key]) } : {}),
      set: async (items: Record<string, unknown>) => { Object.assign(local, structuredClone(items)); },
    } } });
    vi.resetModules();
    const store = await import('../src/background/pdfProjectStore');
    local.rpdfProjects = Object.fromEntries([project(DEFAULT_PROJECT_ID), ...Array.from({ length: PDF_PROJECTS_MAX - 1 }, (_, i) => project(`p${i}x`))].map((p) => [p.id, p]));
    expect(await store.applyPdfProjectRequest({ kind: 'create', id: 'pnew', name: 'New' })).toEqual({ changed: false, refused: 'project-limit' });
    expect(await store.applyPdfProjectRequest({ kind: 'rename', id: 'p0x', name: 'Renamed' })).toEqual({ changed: true, refused: null });
    local.rpdfProjectFolders = Object.fromEntries(Array.from({ length: PDF_PROJECT_FOLDERS_MAX }, (_, i) => [`f${i}x`, { id: `f${i}x`, name: 'F', createdAt: 1, renamedAt: 1, deletedAt: 0, order: null, placedAt: 0 }]));
    expect(await store.applyPdfProjectRequest({ kind: 'folder-create', id: 'fnew', name: 'New', order: null })).toEqual({ changed: false, refused: 'folder-limit' });
  });
});

describe('order keys in the model', () => {
  const folder = (id: string, overrides: Partial<PdfProjectFolder> = {}): PdfProjectFolder => ({
    id, name: id, createdAt: NOW - 10_000, renamedAt: NOW - 10_000, deletedAt: 0, order: null, placedAt: 0, ...overrides,
  });
  const topIds = (state: PdfProjectState) => pdfProjectTree(state.projects, state.folders).items.map((item) => (item.kind === 'folder' ? item.folder.id : item.project.id));
  const allKeysValid = (state: PdfProjectState) => [...Object.values(state.projects), ...Object.values(state.folders)].every((x) => x.order === null || isOrderKey(x.order));

  it('never loses a project, folder or member to a bad order key: the key is dropped', () => {
    const tooLong = 'V'.repeat(ORDER_KEY_MAX_CHARS + 1);
    const stored = {
      default: project(DEFAULT_PROJECT_ID),
      pa: { ...project('pa'), order: tooLong },
      pb: { ...project('pb'), order: 'a0', members: [{ docId: 'd1', member: true, pinned: true, pinOrder: tooLong, changedAt: 1 }] },
    };
    const parsed = parsePdfProjects(stored);
    expect(parsed.pa.order).toBeNull();
    expect(parsed.pb.order).toBeNull();
    expect(parsed.pb.members).toEqual([{ docId: 'd1', member: true, pinned: true, pinOrder: null, changedAt: 1 }]);
    expect(parsePdfProjectList(Object.values(stored))?.map((p) => p.id).sort()).toEqual(['default', 'pa', 'pb']);
  });

  it('moves one project to the same spot a thousand times without a key ever going over the limit', () => {
    // What the hub does on a drag: a key between the new neighbours, sent as an 'arrange'.
    let state: PdfProjectState = {
      projects: { default: project(DEFAULT_PROJECT_ID), pa: project('pa', { order: '1' }), pb: project('pb', { order: '2' }), pc: project('pc', { order: '3' }), pd: project('pd', { order: '4' }) },
      folders: {},
    };
    let longest = 0;
    for (let i = 0; i < 1_000; i += 1) {
      // Alternately move pc and pd right after pa: always into the narrowing gap after pa.
      const moving = i % 2 === 0 ? 'pc' : 'pd';
      const siblings = topIds(state).filter((id) => id !== moving);
      const at = siblings.indexOf('pa') + 1;
      const before = state.projects[siblings[at - 1]].order;
      const after = state.projects[siblings[at]]?.order ?? null;
      const key = orderKeyBetween(before, after);
      const update = parsePdfFolderUpdate({ kind: 'arrange', projects: [{ id: moving, folder: null, order: key }], folders: [] });
      expect(update, `move ${i}: key of ${key.length}`).not.toBeNull();
      longest = Math.max(longest, key.length);
      state = applyPdfFolderUpdate(state, update!, NOW + i);
      expect(allKeysValid(state)).toBe(true);
      expect(topIds(state).slice(0, 2)).toEqual(['pa', moving]);
      expect(topIds(state)).toHaveLength(4);
    }
    // The hub's keys did run past the limit; the model re-keyed the level each time.
    expect(longest).toBeGreaterThan(ORDER_KEY_MAX_CHARS);
    // Stored and read back, nothing is dropped.
    expect(Object.keys(parsePdfProjects(state.projects)).sort()).toEqual(['default', 'pa', 'pb', 'pc', 'pd']);
  });

  it('lets a folder\'s projects out between two close long keys, re-keying the level when the keys would be too long', () => {
    // A folder and the item after it whose keys differ only in the last place, after many moves.
    const base = 'V'.repeat(ORDER_KEY_MAX_CHARS - 2);
    const inside = Array.from({ length: 40 }, (_, i) => project(`pin${String(i).padStart(2, '0')}x`, { folder: 'f1', order: `${String.fromCharCode(65 + Math.floor(i / 10))}${i % 10 + 1}` }));
    let state: PdfProjectState = {
      projects: Object.fromEntries([project(DEFAULT_PROJECT_ID), project('pa', { order: '1' }), project('pz', { order: `${base}W2` }), ...inside].map((p) => [p.id, p])),
      folders: { f1: folder('f1', { order: `${base}W1` }) },
    };
    // Keys between those two for 40 projects would run past the limit.
    expect(orderKeysBetween(state.folders.f1.order, state.projects.pz.order, inside.length).some((key) => !isOrderKey(key))).toBe(true);
    const before = pdfProjectTree(state.projects, state.folders).items.flatMap((item) => (item.kind === 'folder' ? item.projects.map((p) => p.id) : [item.project.id]));
    state = applyPdfFolderUpdate(state, { kind: 'folder-delete', id: 'f1' }, NOW);
    expect(allKeysValid(state)).toBe(true);
    // Out where the folder stood, in their order, and every project survives storage.
    expect(topIds(state)).toEqual(before);
    const parsed = parsePdfProjects(state.projects);
    expect(Object.keys(parsed)).toHaveLength(43);
    expect(Object.values(parsed).every((p) => p.id === DEFAULT_PROJECT_ID || p.order !== null)).toBe(true);
    const keys = topIds(state).map((id) => state.projects[id].order!);
    expect([...keys].sort(compareOrderKeys)).toEqual(keys);
  });
});
