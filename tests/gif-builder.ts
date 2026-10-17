import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GifWriter } = require('omggif') as {
  GifWriter: new (
    buf: number[],
    width: number,
    height: number,
    opts?: { loop?: number; palette?: number[]; background?: number },
  ) => {
    addFrame(
      x: number,
      y: number,
      w: number,
      h: number,
      indexed: number[] | Uint8Array,
      opts?: { delay?: number; disposal?: number; palette?: number[]; transparent?: number },
    ): number;
    end(): number;
  };
};

export const RED = 0xff0000;
export const GREEN = 0x00ff00;
export const BLUE = 0x0000ff;
export const WHITE = 0xffffff;
export const BLACK = 0x000000;

export interface BuiltFrame {
  x?: number;
  y?: number;
  w: number;
  h: number;
  pixels: number[];
  /** Centiseconds. */
  delay?: number;
  disposal?: number;
  transparent?: number;
  palette?: number[];
}

export function buildGif(options: {
  width: number;
  height: number;
  loop?: number;
  palette?: number[];
  background?: number;
  frames: BuiltFrame[];
}): Uint8Array {
  const buf: number[] = [];
  const gopts: { loop?: number; palette?: number[]; background?: number } = {};
  if (options.loop !== undefined) gopts.loop = options.loop;
  if (options.palette) gopts.palette = options.palette;
  if (options.background !== undefined) gopts.background = options.background;
  const writer = new GifWriter(buf, options.width, options.height, gopts);
  for (const frame of options.frames) {
    writer.addFrame(frame.x ?? 0, frame.y ?? 0, frame.w, frame.h, frame.pixels, {
      delay: frame.delay ?? 0,
      disposal: frame.disposal,
      transparent: frame.transparent,
      palette: frame.palette,
    });
  }
  return Uint8Array.from(buf.slice(0, writer.end()));
}

export function fill(count: number, index: number): number[] {
  return new Array(count).fill(index);
}

export function pixel(rgba: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
}
