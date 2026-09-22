// ─── IndexedDB: two stores ───
//
//   settings        — key/value (viewer toggles, paper-strip key, sync config/state)
//   pdf_annotations — one PdfAnnotationCache per document identity

import { DB_NAME, DB_VERSION, STORE_PDF_ANNOTATIONS, STORE_SETTINGS } from '../shared/constants';

let dbInstance: IDBDatabase | null = null;

export function closeDB(): void {
  dbInstance?.close();
  dbInstance = null;
}

export function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_PDF_ANNOTATIONS)) {
        const store = db.createObjectStore(STORE_PDF_ANNOTATIONS, { keyPath: 'docId' });
        store.createIndex('by_updatedAt', 'updatedAt', { unique: false });
      }
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      dbInstance.onversionchange = () => {
        dbInstance?.close();
        dbInstance = null;
      };
      resolve(dbInstance);
    };

    request.onerror = () => reject(request.error);
  });
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGet<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readonly');
  return requestToPromise(tx.objectStore(storeName).get(key) as IDBRequest<T | undefined>);
}

export async function dbPut<T>(storeName: string, value: T): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  await requestToPromise(tx.objectStore(storeName).put(value));
}

export async function dbDelete(storeName: string, key: IDBValidKey): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  await requestToPromise(tx.objectStore(storeName).delete(key));
}

export async function dbGetAll<T>(storeName: string): Promise<T[]> {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readonly');
  return requestToPromise(tx.objectStore(storeName).getAll() as IDBRequest<T[]>);
}
