import { inflateBytes } from '../gif/compress';
import type { Frame } from '../types';

const LIMIT = 8;

interface Entry {
  bitmap: ImageBitmap;
  pixels: Blob;
}

/**
 * Keeps a few decoded frames as ImageBitmaps. The key is the frame id plus
 * the blob object, so a duplicated frame can miss until its pixels change.
 */
export class BitmapCache {
  private entries = new Map<string, Entry>();
  private order: string[] = [];
  private inflight = new Map<string, { pixels: Blob; promise: Promise<ImageBitmap> }>();

  async get(frame: Frame, width: number, height: number): Promise<ImageBitmap> {
    const hit = this.entries.get(frame.id);
    if (hit && hit.pixels === frame.pixels) {
      this.touch(frame.id);
      return hit.bitmap;
    }
    const pending = this.inflight.get(frame.id);
    if (pending && pending.pixels === frame.pixels) return pending.promise;
    const promise = this.load(frame, width, height);
    this.inflight.set(frame.id, { pixels: frame.pixels, promise });
    try {
      return await promise;
    } finally {
      const current = this.inflight.get(frame.id);
      if (current?.promise === promise) this.inflight.delete(frame.id);
    }
  }

  invalidate(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.bitmap.close();
    this.entries.delete(id);
    this.order = this.order.filter((item) => item !== id);
    this.inflight.delete(id);
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.bitmap.close();
    this.entries.clear();
    this.order = [];
    this.inflight.clear();
  }

  private async load(frame: Frame, width: number, height: number): Promise<ImageBitmap> {
    const inflated = await inflateBytes(frame.pixels);
    const expected = width * height * 4;
    if (inflated.byteLength !== expected) throw new Error('Frame size does not match.');
    const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(inflated), width, height));
    const previous = this.entries.get(frame.id);
    if (previous) previous.bitmap.close();
    this.entries.set(frame.id, { bitmap, pixels: frame.pixels });
    this.touch(frame.id);
    while (this.order.length > LIMIT) {
      const oldest = this.order.shift();
      if (!oldest) break;
      const entry = this.entries.get(oldest);
      if (!entry) continue;
      entry.bitmap.close();
      this.entries.delete(oldest);
    }
    return bitmap;
  }

  private touch(id: string): void {
    this.order = this.order.filter((item) => item !== id);
    this.order.push(id);
  }
}
