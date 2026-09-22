// "필기가 두 곳에 있습니다" dialog: the file and the browser cache both hold
// annotations the other lacks. Offers whole-side choices and a per-annotation
// pick list; hovering a row flashes that annotation in the document.

import {
  describeCachedItem,
  describeFileAnnotation,
  type AnnotationConflictChoice,
  type AnnotationReconciliation,
} from '../../shared/pdfAnnotations';
import { byId, el } from './dom';

type Conflict = Extract<AnnotationReconciliation, { kind: 'conflict' }>;

interface Hooks {
  preview(pageIndex: number, rect: number[]): void;
}

export function showAnnotationConflictDialog(conflict: Conflict, hooks: Hooks): Promise<AnnotationConflictChoice> {
  const dialog = byId<HTMLDialogElement>('vocab-t-pdf-annot-conflict');
  const summary = byId<HTMLParagraphElement>('vt-conflict-summary');
  const choices = byId<HTMLDivElement>('vt-conflict-choices');
  const pick = byId<HTMLDivElement>('vt-conflict-pick');
  const fileList = byId<HTMLUListElement>('vt-conflict-file-list');
  const cacheList = byId<HTMLUListElement>('vt-conflict-cache-list');
  const fileCount = byId<HTMLSpanElement>('vt-conflict-file-count');
  const cacheCount = byId<HTMLSpanElement>('vt-conflict-cache-count');

  summary.textContent =
    `이 PDF 파일에는 브라우저에 없는 필기 ${conflict.fileOnly.length}개가, `
    + `브라우저에는 파일에 없는 필기 ${conflict.cacheOnly.length}개가 저장돼 있습니다. 어느 쪽을 유지할까요?`;
  fileCount.textContent = String(conflict.fileOnly.length);
  cacheCount.textContent = String(conflict.cacheOnly.length);

  const fileChecks = new Map<string, HTMLInputElement>();
  const cacheChecks = new Map<string, HTMLInputElement>();
  const row = (label: string, pageIndex: number, rect: number[], onCheck: (input: HTMLInputElement) => void) => {
    const input = el('input', { type: 'checkbox', checked: true });
    onCheck(input);
    const text = el('span', { className: 'vt-conflict-label', textContent: label });
    const li = el('li', { className: 'vt-conflict-row' }, [el('label', {}, [input, text])]);
    const show = () => hooks.preview(pageIndex, rect);
    li.addEventListener('mouseenter', show);
    input.addEventListener('focus', show);
    return li;
  };
  fileList.replaceChildren(...conflict.fileOnly.map((m) => row(describeFileAnnotation(m), m.pageIndex, m.rect, (i) => fileChecks.set(m.id, i))));
  cacheList.replaceChildren(...conflict.cacheOnly.map((it) => row(describeCachedItem(it), it.pageIndex, it.rect, (i) => cacheChecks.set(it.key, i))));

  return new Promise((resolve) => {
    let settled = false;
    const finish = (choice: AnnotationConflictChoice) => {
      if (settled) return;
      settled = true;
      dialog.close();
      resolve(choice);
    };
    const showPick = (on: boolean) => {
      choices.hidden = on;
      pick.hidden = !on;
      if (on) pick.querySelector<HTMLInputElement>('input')?.focus();
    };
    byId<HTMLButtonElement>('vt-conflict-file').onclick = () => finish({ kind: 'file' });
    byId<HTMLButtonElement>('vt-conflict-browser').onclick = () => finish({ kind: 'browser' });
    byId<HTMLButtonElement>('vt-conflict-both').onclick = () => finish({ kind: 'both' });
    byId<HTMLButtonElement>('vt-conflict-pick-open').onclick = () => showPick(true);
    byId<HTMLButtonElement>('vt-conflict-pick-back').onclick = () => showPick(false);
    byId<HTMLButtonElement>('vt-conflict-pick-apply').onclick = () => finish({
      kind: 'pick',
      keepFileIds: new Set(Array.from(fileChecks).filter(([, i]) => i.checked).map(([id]) => id)),
      keepItemKeys: new Set(Array.from(cacheChecks).filter(([, i]) => i.checked).map(([key]) => key)),
    });
    for (const [btnId, checks, value] of [
      ['vt-conflict-file-all', fileChecks, true], ['vt-conflict-file-none', fileChecks, false],
      ['vt-conflict-cache-all', cacheChecks, true], ['vt-conflict-cache-none', cacheChecks, false],
    ] as const) {
      byId<HTMLButtonElement>(btnId).onclick = () => { for (const input of checks.values()) input.checked = value; };
    }
    // Escape / backdrop: keep everything — nothing is lost and the cache stays.
    dialog.onclose = () => finish({ kind: 'both' });
    showPick(false);
    dialog.showModal();
  });
}
