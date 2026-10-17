import { decompressFrame, parseGIF } from 'gifuct-js';

export interface DecodedFrame {
  rgba: Uint8ClampedArray;
  delayMs: number;
}

export interface DecodedGif {
  width: number;
  height: number;
  /** -1 play once, 0 forever, otherwise Netscape repeat count. */
  repeat: number;
  frames: DecodedFrame[];
}

interface Gce {
  delay: number;
  transparentColorIndex: number;
  extras: { disposal: number; transparentColorGiven: boolean };
}

interface RawBlock {
  gce?: Gce;
  image?: {
    descriptor: { top: number; left: number; width: number; height: number };
  };
  application?: { id: string; blocks: Uint8Array | number[] };
}

interface PatchFrame {
  patch: Uint8ClampedArray;
  dims: { top: number; left: number; width: number; height: number };
  disposal: number;
  delayMs: number;
}

const MAX_EDGE = 8192;

/**
 * Composite each GIF frame the way Chrome and Safari show it.
 * Disposal runs after the frame is displayed:
 * 0 and 1 leave the canvas, 2 clears that rectangle to transparent
 * (browsers ignore the GIF background color here), 3 restores the
 * canvas to the pixels from before this frame was drawn.
 * A delay of 0 is kept as 0. Playback may still clamp it.
 */
export async function decodeGif(buffer: ArrayBufferLike): Promise<DecodedGif> {
  const frames: DecodedFrame[] = [];
  const meta = await compositeGif(buffer, (rgba, delayMs) => {
    frames.push({ rgba, delayMs });
  });
  return { ...meta, frames };
}

export interface CompositeStart {
  width: number;
  height: number;
  repeat: number;
  total: number;
}

/** `onFrame` receives its own copy of the composited pixels and may store it. */
export async function compositeGif(
  buffer: ArrayBufferLike,
  onFrame: (rgba: Uint8ClampedArray, delayMs: number, index: number, total: number) => void | Promise<void>,
  onStart?: (info: CompositeStart) => void,
): Promise<{ width: number; height: number; repeat: number }> {
  const bytes = copyBuffer(buffer);
  let parsed: { lsd: { width: number; height: number }; gct: [number, number, number][]; frames: RawBlock[] };
  try {
    parsed = parseGIF(bytes) as typeof parsed;
  } catch {
    throw new Error('Could not read this GIF.');
  }
  if (!parsed?.lsd || !Array.isArray(parsed.frames)) {
    throw new Error('Could not read this GIF.');
  }

  const width = parsed.lsd.width;
  const height = parsed.lsd.height;
  if (width < 1 || height < 1) throw new Error('Could not read this GIF.');
  if (width > MAX_EDGE || height > MAX_EDGE) throw new Error('This GIF size is not supported.');

  const blocks = parsed.frames.filter((block) => block.image);
  if (blocks.length === 0) throw new Error('This GIF has no frames.');
  if (blocks.length > 8000) throw new Error('This GIF has too many frames.');

  const repeat = readRepeat(parsed.frames);
  onStart?.({ width, height, repeat, total: blocks.length });

  const canvas = new Uint8ClampedArray(width * height * 4);
  const restore = new Uint8ClampedArray(width * height * 4);
  const total = blocks.length;

  for (let index = 0; index < blocks.length; index++) {
    const raw = blocks[index];
    const decoded = decompressFrame(raw as unknown as Parameters<typeof decompressFrame>[0], parsed.gct, true);
    if (!decoded?.patch) throw new Error('Could not read a frame in this GIF.');
    const patchFrame: PatchFrame = {
      patch: decoded.patch,
      dims: decoded.dims,
      disposal: raw.gce ? raw.gce.extras.disposal : 0,
      delayMs: raw.gce ? raw.gce.delay * 10 : 0,
    };

    if (patchFrame.disposal === 3) restore.set(canvas);
    blit(canvas, width, height, patchFrame);
    await onFrame(new Uint8ClampedArray(canvas), patchFrame.delayMs, index, total);

    if (patchFrame.disposal === 2) {
      clearRect(canvas, width, height, patchFrame.dims.left, patchFrame.dims.top, patchFrame.dims.width, patchFrame.dims.height);
    } else if (patchFrame.disposal === 3) {
      canvas.set(restore);
    }
  }

  return { width, height, repeat };
}

function copyBuffer(buffer: ArrayBufferLike): ArrayBuffer {
  if (buffer instanceof ArrayBuffer) return buffer;
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(new Uint8Array(buffer));
  return copy.buffer;
}

function readRepeat(blocks: RawBlock[]): number {
  for (const block of blocks) {
    const app = block.application;
    if (!app || app.id !== 'NETSCAPE2.0') continue;
    const bytes = app.blocks;
    if (bytes && bytes.length >= 3 && bytes[0] === 1) {
      return bytes[1] | (bytes[2] << 8);
    }
  }
  return -1;
}

function blit(canvas: Uint8ClampedArray, width: number, height: number, frame: PatchFrame): void {
  const { left, top, width: pw, height: ph } = frame.dims;
  const patch = frame.patch;
  const src = new Uint32Array(patch.buffer, patch.byteOffset, pw * ph);
  const dst = new Uint32Array(canvas.buffer);
  for (let y = 0; y < ph; y++) {
    const dy = top + y;
    if (dy < 0 || dy >= height) continue;
    const row = y * pw;
    const destRow = dy * width;
    for (let x = 0; x < pw; x++) {
      const dx = left + x;
      if (dx < 0 || dx >= width) continue;
      const pixel = src[row + x];
      if ((pixel >>> 24) === 0) continue;
      dst[destRow + dx] = pixel;
    }
  }
}

function clearRect(
  canvas: Uint8ClampedArray,
  width: number,
  height: number,
  left: number,
  top: number,
  fw: number,
  fh: number,
): void {
  const dst = new Uint32Array(canvas.buffer);
  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(width, left + fw);
  const y1 = Math.min(height, top + fh);
  for (let y = y0; y < y1; y++) {
    dst.fill(0, y * width + x0, y * width + x1);
  }
}
