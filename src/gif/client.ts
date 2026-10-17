import type { EncodeDone, InMessage, OutMessage, TransformDone } from '../protocol';

export interface DecodeFrame {
  index: number;
  total: number;
  delayMs: number;
  pixels: ArrayBuffer;
  thumb: ArrayBuffer;
}

export interface DecodeStartInfo {
  width: number;
  height: number;
  repeat: number;
  total: number;
}

interface DecodeCallbacks {
  onStart: (info: DecodeStartInfo) => void;
  onFrame: (frame: DecodeFrame) => void;
}

type JobKind = 'decode' | 'encode' | 'transform';

interface Pending {
  job: number;
  kind: JobKind;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onStart?: DecodeCallbacks['onStart'];
  onFrame?: DecodeCallbacks['onFrame'];
  onProgress?: (index: number, total: number) => void;
}

export class GifClient {
  private worker: Worker;
  private nextJob = 1;
  private pending: Pending | null = null;

  constructor() {
    this.worker = this.spawn();
  }

  decode(buffer: ArrayBuffer, callbacks: DecodeCallbacks): Promise<void> {
    const job = this.prepare();
    return new Promise<void>((resolve, reject) => {
      this.pending = { job, kind: 'decode', resolve: () => resolve(), reject, onStart: callbacks.onStart, onFrame: callbacks.onFrame };
      this.worker.postMessage({ type: 'decode', job, buffer } satisfies InMessage, [buffer]);
    });
  }

  encode(
    payload: Omit<Extract<InMessage, { type: 'encode' }>, 'type' | 'job'>,
    onProgress?: (index: number, total: number) => void,
  ): Promise<Uint8Array> {
    const job = this.prepare();
    const transfer = payload.frames.map((frame) => frame.pixels);
    return new Promise<Uint8Array>((resolve, reject) => {
      this.pending = { job, kind: 'encode', resolve: (value) => resolve(value as Uint8Array), reject, onProgress };
      this.worker.postMessage({ type: 'encode', job, ...payload } satisfies InMessage, transfer);
    });
  }

  transform(payload: Omit<Extract<InMessage, { type: 'transform' }>, 'type' | 'job'>): Promise<TransformDone> {
    const job = this.prepare();
    const transfer = payload.frames.map((frame) => frame.pixels);
    return new Promise<TransformDone>((resolve, reject) => {
      this.pending = { job, kind: 'transform', resolve: (value) => resolve(value as TransformDone), reject };
      this.worker.postMessage({ type: 'transform', job, ...payload } satisfies InMessage, transfer);
    });
  }

  /** Stop an in-flight export. Decode and transform jobs are left running. */
  cancelEncode(): void {
    if (this.pending?.kind !== 'encode') return;
    this.restart(new Error('Cancelled'));
  }

  private prepare(): number {
    if (this.pending?.kind === 'encode') this.cancelEncode();
    else if (this.pending) throw new Error('Busy');
    return this.nextJob++;
  }

  private spawn(): Worker {
    const worker = new Worker(new URL('../workers/gif.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<OutMessage>) => this.onMessage(event.data);
    worker.onerror = () => {
      if (!this.pending) return;
      this.restart(new Error('The editor worker stopped.'));
    };
    return worker;
  }

  private restart(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    this.worker.terminate();
    this.worker = this.spawn();
    pending?.reject(error);
  }

  private onMessage(message: OutMessage): void {
    const pending = this.pending;
    if (!pending || message.job !== pending.job) return;
    if (message.type === 'error') {
      this.pending = null;
      pending.reject(new Error(message.message));
      return;
    }
    if (pending.kind === 'decode') {
      if (message.type === 'decode-start') pending.onStart?.({ width: message.width, height: message.height, repeat: message.repeat, total: message.total });
      else if (message.type === 'decode-frame') pending.onFrame?.(message);
      else if (message.type === 'decode-done') {
        this.pending = null;
        pending.resolve(undefined);
      }
      return;
    }
    if (pending.kind === 'encode') {
      if (message.type === 'encode-progress') pending.onProgress?.(message.index, message.total);
      else if (message.type === 'encode-done') {
        this.pending = null;
        const done = message as EncodeDone;
        pending.resolve(new Uint8Array(done.buffer));
      }
      return;
    }
    if (message.type === 'transform-done') {
      this.pending = null;
      pending.resolve(message);
    }
  }
}
