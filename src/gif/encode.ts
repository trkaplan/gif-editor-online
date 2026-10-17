import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { GifWriter } from 'omggif';

export interface EncodeFrame {
  rgba: Uint8ClampedArray;
  delayMs: number;
}

export interface EncodeOptions {
  maxColors: number;
  dither: 'none' | 'floyd';
  /** -1 once, 0 forever, otherwise Netscape repeat count. */
  repeat: number;
  /**
   * Write every frame as a full canvas with its own palette.
   * Tests use this to measure the delta encoder against the old path.
   */
  fullFrame?: boolean;
}

const littleEndian = new Uint8Array(new Uint16Array([0x1234]).buffer)[0] === 0x34;

/**
 * Frames are buffered, then written with one global palette and only the
 * changed rectangle. Delays are stored in centiseconds, so they round to the
 * nearest 10ms. `fullFrame` keeps the previous full-canvas encoder.
 */
export interface GifSink {
  addFrame(rgba: Uint8ClampedArray, delayMs: number): void;
  finish(): Uint8Array;
}

const MAX_CS = 65535;
/** Mean squared RGB error above which a frame gets its own palette. */
const LOCAL_PALETTE_ERROR = 2500;
const EMPTY_FRAME = new Uint8ClampedArray(0);

export function createGifSink(width: number, height: number, options: EncodeOptions): GifSink {
  const maxColors = Math.max(2, Math.min(256, Math.round(options.maxColors)));
  if (options.fullFrame) return createFullSink(width, height, { ...options, maxColors });
  const frames: EncodeFrame[] = [];
  return {
    addFrame(rgba, delayMs) {
      frames.push({ rgba, delayMs });
    },
    finish() {
      return encodeDelta(width, height, frames, { ...options, maxColors });
    },
  };
}

function createFullSink(width: number, height: number, options: EncodeOptions & { maxColors: number }): GifSink {
  const gif = GIFEncoder();
  return {
    addFrame(rgba, delayMs) {
      const indexed = indexFrame(rgba, width, height, options.maxColors, options.dither);
      gif.writeFrame(indexed.index, width, height, {
        palette: indexed.palette,
        delay: Math.max(0, Math.round(delayMs)),
        repeat: options.repeat,
        transparent: indexed.transparent,
        transparentIndex: 0,
        dispose: 2,
      });
    },
    finish() {
      gif.finish();
      return gif.bytes();
    },
  };
}

export function encodeGif(
  width: number,
  height: number,
  frames: EncodeFrame[],
  options: EncodeOptions,
): Uint8Array {
  if (frames.length === 0) throw new Error('Nothing to export.');
  const sink = createGifSink(width, height, options);
  for (const frame of frames) sink.addFrame(frame.rgba, frame.delayMs);
  return sink.finish();
}

interface Rgb {
  colors: number[][];
  /** Index 0 is the transparent slot and is not a drawable color. */
  reserve: boolean;
  exact: Map<number, number> | null;
}

interface Planned {
  x: number;
  y: number;
  w: number;
  h: number;
  index: Uint8Array;
  delayCs: number;
  dispose: number;
  transparent: boolean;
  local: number[][] | null;
}

function encodeDelta(width: number, height: number, frames: EncodeFrame[], options: EncodeOptions & { maxColors: number }): Uint8Array {
  if (frames.length === 0) throw new Error('Nothing to export.');
  const palette = buildPalette(frames, width, height, options.maxColors);
  const nearest = palette.exact ? null : makeNearest(palette.colors, palette.reserve ? 0 : null);
  const dither = options.dither === 'floyd' && !palette.exact;
  const planned: Planned[] = [];
  let prev: Uint8ClampedArray | null = null;
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    const rgba = frame.rgba;
    const delayCs = centiseconds(frame.delayMs);
    // The worker drops its copy after addFrame. Release ours once this frame is planned.
    frames[index] = { rgba: EMPTY_FRAME, delayMs: 0 };
    const next = planFrame(rgba, width, height, prev, palette, nearest, dither, options.maxColors, delayCs);
    if (next.merge) {
      const last = planned[planned.length - 1];
      if (last) last.delayCs = Math.min(MAX_CS, last.delayCs + delayCs);
      continue;
    }
    planned.push(next.frame);
    prev = next.prev;
  }
  return writePlanned(width, height, planned, palette.colors, options.repeat);
}

function planFrame(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  prev: Uint8ClampedArray | null,
  palette: Rgb,
  nearest: ((r: number, g: number, b: number) => number) | null,
  dither: boolean,
  maxColors: number,
  delayCs: number,
): { merge: true } | { merge: false; frame: Planned; prev: Uint8ClampedArray } {
  const count = width * height;
  let transparent = false;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 128) {
      transparent = true;
      break;
    }
  }
  const choose = colorChooser(palette, nearest, dither);
  if (transparent || !prev) {
    const index = new Uint8Array(count);
    for (let p = 0; p < count; p++) {
      const i = p * 4;
      index[p] = rgba[i + 3] < 128 ? 0 : choose(rgba[i], rgba[i + 1], rgba[i + 2], p % width, (p / width) | 0);
    }
    const canvas = new Uint8ClampedArray(count * 4);
    if (!transparent) paintIndexed(canvas, width, index, 0, 0, width, height, palette.colors, false);
    return {
      merge: false,
      frame: {
        x: 0,
        y: 0,
        w: width,
        h: height,
        index,
        delayCs,
        dispose: transparent ? 2 : 1,
        transparent: transparent || palette.reserve,
        local: null,
      },
      prev: canvas,
    };
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let error = 0;
  let opaque = 0;
  const unique = new Set<number>();
  const colorCap = maxColors + 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
      if (unique.size < colorCap) unique.add(key);
      const pi = choose(rgba[i], rgba[i + 1], rgba[i + 2], x, y);
      const color = palette.colors[pi];
      opaque++;
      const dr = rgba[i] - color[0];
      const dg = rgba[i + 1] - color[1];
      const db = rgba[i + 2] - color[2];
      error += dr * dr + dg * dg + db * db;
      if (prev[i] !== color[0] || prev[i + 1] !== color[1] || prev[i + 2] !== color[2] || prev[i + 3] < 128) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { merge: true };
  const mse = opaque > 0 ? error / opaque : 0;
  const budget = palette.reserve ? maxColors - 1 : maxColors;
  const globalTooCoarse = !palette.exact && unique.size > budget && mse > LOCAL_PALETTE_ERROR;
  const box = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  if (globalTooCoarse) {
    const local = localPalette(rgba, width, box, maxColors);
    const localChoose = colorChooser(local, local.exact ? null : makeNearest(local.colors, 0), dither && !local.exact);
    return writeBox(rgba, width, prev, box, local, localChoose, true, delayCs, true);
  }
  return writeBox(rgba, width, prev, box, palette, choose, palette.reserve, delayCs, false);
}

function writeBox(
  rgba: Uint8ClampedArray,
  width: number,
  prev: Uint8ClampedArray,
  box: { x: number; y: number; w: number; h: number },
  palette: Rgb,
  choose: (r: number, g: number, b: number, x: number, y: number) => number,
  punch: boolean,
  delayCs: number,
  ownPalette: boolean,
): { merge: false; frame: Planned; prev: Uint8ClampedArray } {
  const index = new Uint8Array(box.w * box.h);
  let cursor = 0;
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const i = (y * width + x) * 4;
      const pi = choose(rgba[i], rgba[i + 1], rgba[i + 2], x, y);
      const color = palette.colors[pi];
      const unchanged = prev[i] === color[0] && prev[i + 1] === color[1] && prev[i + 2] === color[2] && prev[i + 3] >= 128;
      if (punch && unchanged) index[cursor++] = 0;
      else index[cursor++] = pi;
    }
  }
  const canvas = prev;
  paintIndexed(canvas, width, index, box.x, box.y, box.w, box.h, palette.colors, punch);
  return {
    merge: false,
    frame: {
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      index,
      delayCs,
      dispose: 1,
      transparent: punch,
      local: ownPalette ? palette.colors : null,
    },
    prev: canvas,
  };
}

function buildPalette(frames: EncodeFrame[], width: number, height: number, maxColors: number): Rgb {
  const seen = new Map<number, number>();
  let overflow = false;
  let anyTransparent = false;
  const target = 48000;
  const step = Math.max(1, Math.floor((frames.length * width * height) / target));
  const sample = new Uint8Array(target * 4);
  let samples = 0;
  let cursor = 0;
  for (const frame of frames) {
    const rgba = frame.rgba;
    const count = width * height;
    for (let p = 0; p < count; p++) {
      const i = p * 4;
      if (rgba[i + 3] < 128) {
        anyTransparent = true;
        continue;
      }
      if (!overflow) {
        const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
        if (!seen.has(key)) {
          if (seen.size >= maxColors) overflow = true;
          else seen.set(key, seen.size);
        }
      }
      if (cursor++ % step === 0 && samples < target) {
        const o = samples * 4;
        sample[o] = rgba[i];
        sample[o + 1] = rgba[i + 1];
        sample[o + 2] = rgba[i + 2];
        sample[o + 3] = 255;
        samples++;
      }
    }
  }
  const reserve = anyTransparent || (frames.length > 1 && (overflow || seen.size <= maxColors - 1));
  const budget = Math.max(1, reserve ? maxColors - 1 : maxColors);
  if (!overflow && seen.size <= budget) {
    const colors: number[][] = reserve ? [[0, 0, 0]] : [];
    const exact = new Map<number, number>();
    const keys = [...seen.keys()].sort((a, b) => a - b);
    for (const key of keys) {
      exact.set(key, colors.length);
      colors.push([(key >> 16) & 255, (key >> 8) & 255, key & 255]);
    }
    if (colors.length < 2) colors.push([0, 0, 0]);
    return { colors, reserve, exact };
  }
  const quantized = quantizeColors(sample.subarray(0, Math.max(4, samples * 4)), Math.max(1, budget));
  const colors = reserve ? [[0, 0, 0], ...quantized] : quantized;
  if (colors.length < 2) colors.push([0, 0, 0]);
  return { colors, reserve, exact: null };
}

function localPalette(
  rgba: Uint8ClampedArray,
  width: number,
  box: { x: number; y: number; w: number; h: number },
  maxColors: number,
): Rgb {
  const seen = new Map<number, number>();
  let overflow = false;
  const sample = new Uint8Array(Math.max(4, Math.min(box.w * box.h, 20000) * 4));
  let samples = 0;
  const step = Math.max(1, Math.floor((box.w * box.h) / 20000));
  let cursor = 0;
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const i = (y * width + x) * 4;
      if (rgba[i + 3] < 128) continue;
      const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
      if (!overflow && !seen.has(key)) {
        if (seen.size >= maxColors - 1) overflow = true;
        else seen.set(key, seen.size);
      }
      if (cursor++ % step === 0 && samples < sample.length / 4) {
        const o = samples * 4;
        sample[o] = rgba[i];
        sample[o + 1] = rgba[i + 1];
        sample[o + 2] = rgba[i + 2];
        sample[o + 3] = 255;
        samples++;
      }
    }
  }
  if (!overflow) {
    const colors: number[][] = [[0, 0, 0]];
    const exact = new Map<number, number>();
    for (const key of [...seen.keys()].sort((a, b) => a - b)) {
      exact.set(key, colors.length);
      colors.push([(key >> 16) & 255, (key >> 8) & 255, key & 255]);
    }
    if (colors.length < 2) colors.push([0, 0, 0]);
    return { colors, reserve: true, exact };
  }
  const quantized = quantizeColors(sample.subarray(0, Math.max(4, samples * 4)), Math.max(1, maxColors - 1));
  return { colors: [[0, 0, 0], ...quantized], reserve: true, exact: null };
}

function quantizeColors(sample: Uint8Array, budget: number): number[][] {
  const tight = new Uint8Array(Math.max(4, sample.length - (sample.length % 4)));
  tight.set(sample.subarray(0, tight.length));
  if (tight[3] === 0) tight[3] = 255;
  const count = Math.max(2, Math.min(256, budget));
  const colors = quantize(tight, count)
    .slice(0, budget)
    .map((color) => [color[0] ?? 0, color[1] ?? 0, color[2] ?? 0]);
  return colors.length > 0 ? colors : [[0, 0, 0]];
}

function colorChooser(
  palette: Rgb,
  nearest: ((r: number, g: number, b: number) => number) | null,
  dither: boolean,
): (r: number, g: number, b: number, x: number, y: number) => number {
  const exact = palette.exact;
  return (r, g, b, x, y) => {
    let rr = r;
    let gg = g;
    let bb = b;
    if (dither) {
      const shift = ((BAYER[(y & 7) * 8 + (x & 7)] - 32) / 64) * 32;
      rr = clampByte(r + shift);
      gg = clampByte(g + shift);
      bb = clampByte(b + shift);
    }
    if (exact) return exact.get((rr << 16) | (gg << 8) | bb) ?? exact.get((r << 16) | (g << 8) | b) ?? 1;
    return nearest ? nearest(rr, gg, bb) : 1;
  };
}

function paintIndexed(
  canvas: Uint8ClampedArray,
  width: number,
  index: Uint8Array,
  originX: number,
  originY: number,
  boxW: number,
  boxH: number,
  colors: number[][],
  punch: boolean,
): void {
  let cursor = 0;
  for (let y = 0; y < boxH; y++) {
    for (let x = 0; x < boxW; x++) {
      const pi = index[cursor++];
      if (punch && pi === 0) continue;
      const color = colors[pi] ?? colors[0];
      const i = ((originY + y) * width + originX + x) * 4;
      canvas[i] = color[0];
      canvas[i + 1] = color[1];
      canvas[i + 2] = color[2];
      canvas[i + 3] = 255;
    }
  }
}

function writePlanned(width: number, height: number, frames: Planned[], globalColors: number[][], repeat: number): Uint8Array {
  const buf: number[] = [];
  const opts: { palette: number[]; loop?: number } = { palette: packPalette(globalColors) };
  if (repeat >= 0) opts.loop = repeat;
  const writer = new GifWriter(buf, width, height, opts);
  for (const frame of frames) {
    writer.addFrame(frame.x, frame.y, frame.w, frame.h, frame.index, {
      delay: frame.delayCs,
      disposal: frame.dispose,
      transparent: frame.transparent ? 0 : undefined,
      palette: frame.local ? packPalette(frame.local) : undefined,
    });
  }
  return Uint8Array.from(buf.slice(0, writer.end()));
}

function packPalette(colors: number[][]): number[] {
  const packed = colors.map(([r, g, b]) => ((r & 255) << 16) | ((g & 255) << 8) | (b & 255));
  let size = 2;
  while (size < packed.length) size *= 2;
  const last = packed[packed.length - 1] ?? 0;
  while (packed.length < size) packed.push(last);
  return packed;
}

function centiseconds(delayMs: number): number {
  return Math.max(0, Math.min(MAX_CS, Math.round(delayMs / 10)));
}

/** Ordered dither keeps a static pixel on the same palette index in every frame. */
const BAYER = new Uint8Array([
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35,
  11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
]);

function indexFrame(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  maxColors: number,
  dither: 'none' | 'floyd',
): { index: Uint8Array; palette: number[][]; transparent: boolean } {
  const pixelCount = width * height;
  let transparent = false;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 128) {
      transparent = true;
      break;
    }
  }

  const exact = collectExact(rgba, pixelCount, maxColors, transparent);
  if (exact) {
    const index = new Uint8Array(pixelCount);
    for (let p = 0; p < pixelCount; p++) {
      const i = p * 4;
      if (transparent && rgba[i + 3] < 128) {
        index[p] = 0;
        continue;
      }
      const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
      index[p] = exact.map.get(key) ?? 0;
    }
    return { index, palette: exact.palette, transparent };
  }

  const colorBudget = transparent ? Math.max(1, maxColors - 1) : maxColors;
  const opaque = opaquePixels(rgba);
  let palette = quantize(opaque, colorBudget).slice(0, colorBudget).map((color) => color.slice(0, 3));
  if (palette.length === 0) palette = [[0, 0, 0]];
  if (transparent) palette = [[0, 0, 0], ...palette];
  const skip = transparent ? 0 : null;

  if (dither === 'floyd') {
    return { index: floyd(rgba, width, height, palette, skip), palette, transparent };
  }

  const index = new Uint8Array(pixelCount);
  if (!littleEndian) {
    const nearest = makeNearest(palette, skip);
    for (let p = 0; p < pixelCount; p++) {
      const i = p * 4;
      index[p] = transparent && rgba[i + 3] < 128 ? 0 : nearest(rgba[i], rgba[i + 1], rgba[i + 2]);
    }
    return { index, palette, transparent };
  }

  const tight = tightCopy(rgba);
  const searchable = transparent ? palette.slice(1) : palette;
  const mapped = applyPalette(transparent ? opaqueLooking(tight) : tight, searchable, 'rgb565');
  for (let p = 0; p < pixelCount; p++) {
    const i = p * 4;
    if (transparent && rgba[i + 3] < 128) index[p] = 0;
    else index[p] = mapped[p] + (transparent ? 1 : 0);
  }
  return { index, palette, transparent };
}

function collectExact(
  rgba: Uint8ClampedArray,
  pixelCount: number,
  maxColors: number,
  transparent: boolean,
): { palette: number[][]; map: Map<number, number> } | null {
  const limit = transparent ? maxColors - 1 : maxColors;
  const map = new Map<number, number>();
  const palette: number[][] = transparent ? [[0, 0, 0]] : [];
  for (let p = 0; p < pixelCount; p++) {
    const i = p * 4;
    if (transparent && rgba[i + 3] < 128) continue;
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    if (map.has(key)) continue;
    if (map.size >= limit) return null;
    const index = palette.length;
    map.set(key, index);
    palette.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
  }
  if (palette.length === 0) palette.push([0, 0, 0]);
  return { palette, map };
}

function opaquePixels(rgba: Uint8ClampedArray): Uint8Array {
  let count = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] >= 128) count++;
  }
  const out = new Uint8Array(Math.max(1, count) * 4);
  let j = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    out[j++] = rgba[i];
    out[j++] = rgba[i + 1];
    out[j++] = rgba[i + 2];
    out[j++] = 255;
  }
  if (count === 0) out.set([0, 0, 0, 255]);
  return out;
}

/** Give transparent pixels a stand-in color so applyPalette still returns one index per pixel. */
function opaqueLooking(tight: Uint8Array): Uint8Array {
  const out = tight.slice();
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] < 128) {
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 255;
    }
  }
  return out;
}

function tightCopy(rgba: Uint8ClampedArray): Uint8Array {
  const copy = new Uint8Array(rgba.length);
  copy.set(rgba);
  return copy;
}

function floyd(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  palette: number[][],
  skip: number | null,
): Uint8Array {
  const count = width * height;
  const work = new Float32Array(count * 3);
  for (let p = 0; p < count; p++) {
    work[p * 3] = rgba[p * 4];
    work[p * 3 + 1] = rgba[p * 4 + 1];
    work[p * 3 + 2] = rgba[p * 4 + 2];
  }
  const nearest = makeNearest(palette, skip);
  const index = new Uint8Array(count);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (skip !== null && rgba[p * 4 + 3] < 128) {
        index[p] = skip;
        continue;
      }
      const r = clampByte(work[p * 3]);
      const g = clampByte(work[p * 3 + 1]);
      const b = clampByte(work[p * 3 + 2]);
      const pi = nearest(r, g, b);
      index[p] = pi;
      const chosen = palette[pi];
      const er = r - chosen[0];
      const eg = g - chosen[1];
      const eb = b - chosen[2];
      diffuse(work, rgba, width, height, x + 1, y, er, eg, eb, 7 / 16);
      diffuse(work, rgba, width, height, x - 1, y + 1, er, eg, eb, 3 / 16);
      diffuse(work, rgba, width, height, x, y + 1, er, eg, eb, 5 / 16);
      diffuse(work, rgba, width, height, x + 1, y + 1, er, eg, eb, 1 / 16);
    }
  }
  return index;
}

function diffuse(
  work: Float32Array,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  er: number,
  eg: number,
  eb: number,
  factor: number,
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const p = y * width + x;
  if (rgba[p * 4 + 3] < 128) return;
  work[p * 3] += er * factor;
  work[p * 3 + 1] += eg * factor;
  work[p * 3 + 2] += eb * factor;
}

function makeNearest(palette: number[][], skip: number | null): (r: number, g: number, b: number) => number {
  const cache = new Int16Array(65536);
  cache.fill(-1);
  return (r: number, g: number, b: number) => {
    const key = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
    const hit = cache[key];
    if (hit >= 0) return hit;
    let best = skip === 0 ? 1 : 0;
    let bestDist = Infinity;
    for (let i = 0; i < palette.length; i++) {
      if (i === skip) continue;
      const color = palette[i];
      const dr = r - color[0];
      const dg = g - color[1];
      const db = b - color[2];
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
        if (dist === 0) break;
      }
    }
    cache[key] = best;
    return best;
  };
}

function clampByte(n: number): number {
  if (n < 0) return 0;
  if (n > 255) return 255;
  return Math.round(n);
}
