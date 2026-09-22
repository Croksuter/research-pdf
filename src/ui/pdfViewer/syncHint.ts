// ─── Viewer → background sync hints ───
//
// Opening a document asks the background to pull the other devices' drawings
// and reading position first (a no-op round trip when nothing changed: one
// metadata request). Every stored edit asks for a push soon, debounced by the
// background's one-shot alarm.

const OPEN_SYNC_WAIT_MS = 8_000;

function send(reason: 'open' | 'edit'): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'VOCAB_T_PDF_SYNC_HINT', reason }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

/**
 * `open` waits (bounded) so the document opens with fresh data; `edit`
 * returns at once. Never throws.
 */
export function requestPdfSync(reason: 'open' | 'edit'): Promise<void> {
  if (reason === 'edit') {
    void send('edit');
    return Promise.resolve();
  }
  return Promise.race([
    send('open'),
    new Promise<void>((resolve) => { setTimeout(resolve, OPEN_SYNC_WAIT_MS); }),
  ]);
}
