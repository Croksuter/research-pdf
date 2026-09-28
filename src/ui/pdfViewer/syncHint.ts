// ─── Viewer → background sync hints ───
//
// Opening a document asks the background to pull the other devices' drawings
// and reading positions. The viewer does not wait for it: it renders from
// local data and the pull answers with the documents it changed, so only a
// document another device actually touched is reloaded. Every stored edit
// asks for a push soon, debounced by the background's one-shot alarm.

function send(reason: 'open' | 'edit'): Promise<{ changedDocIds: string[] }> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'VOCAB_T_PDF_SYNC_HINT', reason }, (response?: { changedDocIds?: unknown }) => {
        void chrome.runtime.lastError;
        const ids = Array.isArray(response?.changedDocIds) ? response.changedDocIds.filter((id): id is string => typeof id === 'string') : [];
        resolve({ changedDocIds: ids });
      });
    } catch {
      resolve({ changedDocIds: [] });
    }
  });
}

/** Never throws; `edit` resolves at once. */
export function requestPdfSync(reason: 'open' | 'edit'): Promise<{ changedDocIds: string[] }> {
  if (reason === 'edit') {
    void send('edit');
    return Promise.resolve({ changedDocIds: [] });
  }
  return send('open');
}
