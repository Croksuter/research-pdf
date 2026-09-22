import { openDB } from '../src/db/database';
import { STORE_PDF_ANNOTATIONS, STORE_SETTINGS } from '../src/shared/constants';

/** Empties every store so each test starts from a fresh database. */
export async function clearAllStores(): Promise<void> {
  const db = await openDB();
  const names = [STORE_SETTINGS, STORE_PDF_ANNOTATIONS];
  const tx = db.transaction(names, 'readwrite');
  names.forEach((name) => tx.objectStore(name).clear());
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
