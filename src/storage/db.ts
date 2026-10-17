import type { Annotation, Doc, Frame } from '../types';

const DB_NAME = 'gif-editor-online';
const DB_VERSION = 1;

interface MetaRecord {
  width: number;
  height: number;
  repeat: number;
  name: string;
  frames: { id: string; delayMs: number }[];
  annotations: Annotation[];
  selectedIds: string[];
  savedAt: number;
}

interface FrameRecord {
  pixels: Blob;
  thumb: Blob;
}

interface Session {
  doc: Doc;
  annotations: Annotation[];
  selectedIds: string[];
}

const written = new Map<string, { pixels: Blob; thumb: Blob }>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('frames')) db.createObjectStore('frames');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open storage.'));
  });
}

function requestDone<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Storage request failed.'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted.'));
    tx.onerror = () => reject(tx.error ?? new Error('Storage transaction failed.'));
  });
}

export async function saveSession(doc: Doc, annotations: Annotation[], selectedIds: string[]): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(['meta', 'frames'], 'readwrite');
    const meta: MetaRecord = {
      width: doc.width,
      height: doc.height,
      repeat: doc.repeat,
      name: doc.name,
      frames: doc.frames.map((frame) => ({ id: frame.id, delayMs: frame.delayMs })),
      annotations,
      selectedIds,
      savedAt: Date.now(),
    };
    tx.objectStore('meta').put(meta, 'session');
    const keep = new Set(doc.frames.map((frame) => frame.id));
    const nextWritten = new Map(written);
    for (const frame of doc.frames) {
      const prev = written.get(frame.id);
      if (prev && prev.pixels === frame.pixels && prev.thumb === frame.thumb) continue;
      tx.objectStore('frames').put({ pixels: frame.pixels, thumb: frame.thumb } satisfies FrameRecord, frame.id);
      nextWritten.set(frame.id, { pixels: frame.pixels, thumb: frame.thumb });
    }
    for (const id of written.keys()) {
      if (keep.has(id)) continue;
      tx.objectStore('frames').delete(id);
      nextWritten.delete(id);
    }
    await txDone(tx);
    written.clear();
    for (const [id, blobs] of nextWritten) written.set(id, blobs);
  } finally {
    db.close();
  }
}

export async function loadSession(): Promise<Session | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(['meta', 'frames'], 'readonly');
    const meta = await requestDone(tx.objectStore('meta').get('session') as IDBRequest<MetaRecord | undefined>);
    if (!meta || !Array.isArray(meta.frames) || meta.frames.length === 0) {
      await txDone(tx);
      return null;
    }
    const frames: Frame[] = [];
    for (const item of meta.frames) {
      const record = await requestDone(tx.objectStore('frames').get(item.id) as IDBRequest<FrameRecord | undefined>);
      if (!record?.pixels || !record.thumb) throw new Error('Saved frame is missing.');
      frames.push({ id: item.id, delayMs: item.delayMs, pixels: record.pixels, thumb: record.thumb });
    }
    await txDone(tx);
    written.clear();
    for (const frame of frames) written.set(frame.id, { pixels: frame.pixels, thumb: frame.thumb });
    return {
      doc: { width: meta.width, height: meta.height, repeat: meta.repeat, name: meta.name, frames },
      annotations: meta.annotations ?? [],
      selectedIds: meta.selectedIds ?? [],
    };
  } finally {
    db.close();
  }
}

export async function clearSession(): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(['meta', 'frames'], 'readwrite');
    tx.objectStore('meta').clear();
    tx.objectStore('frames').clear();
    await txDone(tx);
    written.clear();
  } finally {
    db.close();
  }
}
