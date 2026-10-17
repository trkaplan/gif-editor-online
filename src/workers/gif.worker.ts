import { deflateBytes, inflateBytes } from '../gif/compress';
import { compositeGif } from '../gif/decode';
import { createGifSink } from '../gif/encode';
import { cropRGBA, scaleRGBA } from '../gif/pixels';
import type { InMessage, OutMessage } from '../protocol';
import type { Annotation } from '../types';
import { drawAnnotations } from '../render/annotate';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<InMessage>) => void) | null;
  postMessage: (message: OutMessage, transfer?: Transferable[]) => void;
};

scope.onmessage = (event: MessageEvent<InMessage>) => {
  void run(event.data);
};

function post(message: OutMessage, transfer?: Transferable[]): void {
  if (transfer) scope.postMessage(message, transfer);
  else scope.postMessage(message);
}

async function run(message: InMessage): Promise<void> {
  try {
    if (message.type === 'decode') await decodeJob(message.job, message.buffer);
    else if (message.type === 'encode') await encodeJob(message);
    else await transformJob(message);
  } catch (error) {
    post({
      type: 'error',
      job: message.job,
      message: error instanceof Error ? error.message : 'Something went wrong.',
    });
  }
}

async function decodeJob(job: number, buffer: ArrayBuffer): Promise<void> {
  let width = 0;
  let height = 0;
  await compositeGif(
    buffer,
    async (rgba, delayMs, index, total) => {
      const pixels = await deflateBuffer(rgba);
      const thumb = await thumbBuffer(rgba, width, height);
      post({ type: 'decode-frame', job, index, total, delayMs, pixels, thumb }, [pixels, thumb]);
    },
    (info) => {
      width = info.width;
      height = info.height;
      post({
        type: 'decode-start',
        job,
        width: info.width,
        height: info.height,
        repeat: info.repeat,
        total: info.total,
      });
    },
  );
  post({ type: 'decode-done', job });
}

async function encodeJob(message: Extract<InMessage, { type: 'encode' }>): Promise<void> {
  if (message.frames.length === 0) throw new Error('Nothing to export.');
  const scale = message.scale > 0 ? message.scale : 1;
  const outW = Math.max(1, Math.round(message.width * scale));
  const outH = Math.max(1, Math.round(message.height * scale));
  const sink = createGifSink(outW, outH, {
    maxColors: message.maxColors,
    dither: message.dither,
    repeat: message.repeat,
  });
  const total = message.frames.length;
  for (let index = 0; index < total; index++) {
    const frame = message.frames[index];
    let rgba = await inflateFrame(frame.pixels, message.width, message.height);
    if (frame.annotations && frame.annotations.length > 0) {
      rgba = rasterize(rgba, message.width, message.height, frame.annotations);
    }
    if (outW !== message.width || outH !== message.height) {
      rgba = scaleRGBA(rgba, message.width, message.height, outW, outH);
    }
    sink.addFrame(rgba, frame.delayMs);
    post({ type: 'encode-progress', job: message.job, index: index + 1, total });
  }
  const buffer = copyBytes(sink.finish());
  post({ type: 'encode-done', job: message.job, buffer }, [buffer]);
}

async function transformJob(message: Extract<InMessage, { type: 'transform' }>): Promise<void> {
  let outW = message.width;
  let outH = message.height;
  if (message.op === 'resize') {
    outW = Math.max(1, Math.round(message.targetWidth ?? message.width));
    outH = Math.max(1, Math.round(message.targetHeight ?? message.height));
  } else if (message.op === 'crop') {
    if (!message.crop) throw new Error('Crop is missing.');
    outW = message.crop.w;
    outH = message.crop.h;
  }
  const frames: { id: string; pixels: ArrayBuffer; thumb: ArrayBuffer }[] = [];
  for (const frame of message.frames) {
    let rgba = await inflateFrame(frame.pixels, message.width, message.height);
    const annotations = frame.annotations ?? message.annotations;
    if (annotations && annotations.length > 0) {
      rgba = rasterize(rgba, message.width, message.height, annotations);
    }
    if (message.op === 'crop' && message.crop) {
      rgba = cropRGBA(rgba, message.width, message.crop.x, message.crop.y, message.crop.w, message.crop.h);
    } else if (message.op === 'resize') {
      rgba = scaleRGBA(rgba, message.width, message.height, outW, outH);
    }
    const pixels = await deflateBuffer(rgba);
    const thumb = await thumbBuffer(rgba, outW, outH);
    frames.push({ id: frame.id, pixels, thumb });
  }
  post({ type: 'transform-done', job: message.job, width: outW, height: outH, frames }, frames.flatMap((frame) => [frame.pixels, frame.thumb]));
}

async function inflateFrame(pixels: ArrayBuffer, width: number, height: number): Promise<Uint8ClampedArray> {
  const inflated = await inflateBytes(new Uint8Array(pixels));
  const expected = width * height * 4;
  if (inflated.byteLength !== expected) throw new Error('Frame size does not match.');
  return new Uint8ClampedArray(inflated);
}

function rasterize(rgba: Uint8ClampedArray, width: number, height: number, annotations: Annotation[]): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not draw on this frame.');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  drawAnnotations(ctx, annotations);
  return new Uint8ClampedArray(ctx.getImageData(0, 0, width, height).data);
}

async function deflateBuffer(rgba: Uint8ClampedArray): Promise<ArrayBuffer> {
  const blob = await deflateBytes(new Uint8Array(rgba));
  return blob.arrayBuffer();
}

async function thumbBuffer(rgba: Uint8ClampedArray, width: number, height: number): Promise<ArrayBuffer> {
  const maxEdge = 160;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const tw = Math.max(1, Math.round(width * scale));
  const th = Math.max(1, Math.round(height * scale));
  const pixels = tw === width && th === height ? rgba : nearest(rgba, width, height, tw, th);
  const canvas = new OffscreenCanvas(tw, th);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not build a thumbnail.');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), tw, th), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blob.arrayBuffer();
}

function nearest(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      const si = (sy * sw + sx) * 4;
      const di = (y * dw + x) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return out;
}

function copyBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
