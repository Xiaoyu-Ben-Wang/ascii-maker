// The saved library in IndexedDB: one metadata row per creation, and its source, mask and thumbnail as blobs.
import type { Params } from '../../engine/index.ts';

export interface StoredLook { preset: string; params: Partial<Params> }
export interface CreationMeta {
  key: string;
  name: string;
  kind: 'image' | 'video';
  width: number;
  height: number;
  look: StoredLook;
  painted: boolean;
  /** The saved thumbnail predates the latest edit. */
  thumbStale?: boolean;
  createdAt: number;
  updatedAt: number;
}
export type BlobKind = 'source' | 'mask' | 'thumb';

const META = 'creations', BLOBS = 'blobs';
let opening: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  return (opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('ascii-maker', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(META, { keyPath: 'key' });
      req.result.createObjectStore(BLOBS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { opening = null; reject(req.error); };
  }));
}

const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error);
});
const result = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const blobKey = (key: string, kind: BlobKind) => `${key}:${kind}`;

export async function listCreations(): Promise<CreationMeta[]> {
  return result((await db()).transaction(META).objectStore(META).getAll());
}

/** Writes the metadata and, in the same transaction, any blobs given (null deletes one). */
export async function saveCreation(meta: CreationMeta, blobs: Partial<Record<BlobKind, Blob | null>> = {}) {
  const tx = (await db()).transaction([META, BLOBS], 'readwrite');
  tx.objectStore(META).put(meta);
  const store = tx.objectStore(BLOBS);
  for (const [kind, blob] of Object.entries(blobs) as [BlobKind, Blob | null][]) {
    if (blob) store.put(blob, blobKey(meta.key, kind));
    else store.delete(blobKey(meta.key, kind));
  }
  await done(tx);
}

export async function saveBlob(key: string, kind: BlobKind, blob: Blob) {
  const tx = (await db()).transaction(BLOBS, 'readwrite');
  tx.objectStore(BLOBS).put(blob, blobKey(key, kind));
  await done(tx);
}

export async function loadBlob(key: string, kind: BlobKind): Promise<Blob | undefined> {
  return result((await db()).transaction(BLOBS).objectStore(BLOBS).get(blobKey(key, kind)));
}

export async function deleteCreation(key: string) {
  const tx = (await db()).transaction([META, BLOBS], 'readwrite');
  tx.objectStore(META).delete(key);
  for (const kind of ['source', 'mask', 'thumb'] as const) tx.objectStore(BLOBS).delete(blobKey(key, kind));
  await done(tx);
}

/** Asks the browser not to evict the library under storage pressure. */
export const persistStorage = () => navigator.storage?.persist?.().catch(() => false);
