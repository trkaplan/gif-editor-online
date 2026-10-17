import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeGif } from '../src/gif/decode';
import { BLACK, BLUE, GREEN, RED, WHITE, buildGif, fill, pixel } from './gif-builder';

const palette = [BLACK, RED, GREEN, BLUE, WHITE, 0xffff00, 0xff00ff, 0x00ffff];

describe('GIF decoder', () => {
  it('composites full opaque frames and keeps a zero delay', async () => {
    const bytes = buildGif({
      width: 2,
      height: 2,
      loop: 0,
      palette,
      frames: [
        { w: 2, h: 2, pixels: fill(4, 1), delay: 0, disposal: 1 },
        { w: 2, h: 2, pixels: fill(4, 3), delay: 25, disposal: 1 },
      ],
    });
    const gif = await decodeGif(bytes.buffer);
    expect(gif.repeat).toBe(0);
    expect(gif.frames).toHaveLength(2);
    expect(gif.frames[0].delayMs).toBe(0);
    expect(gif.frames[1].delayMs).toBe(250);
    expect(pixel(gif.frames[0].rgba, 2, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(gif.frames[1].rgba, 2, 1, 1)).toEqual([0, 0, 255, 255]);
  });

  it('stacks partial updates when disposal keeps the canvas', async () => {
    const bytes = buildGif({
      width: 4,
      height: 4,
      palette,
      frames: [
        { w: 4, h: 4, pixels: fill(16, 1), delay: 10, disposal: 1 },
        { x: 1, y: 1, w: 2, h: 2, pixels: fill(4, 2), delay: 10, disposal: 1 },
      ],
    });
    const gif = await decodeGif(bytes.buffer);
    expect(pixel(gif.frames[1].rgba, 4, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(gif.frames[1].rgba, 4, 1, 1)).toEqual([0, 255, 0, 255]);
    expect(pixel(gif.frames[1].rgba, 4, 2, 2)).toEqual([0, 255, 0, 255]);
    expect(pixel(gif.frames[1].rgba, 4, 3, 3)).toEqual([255, 0, 0, 255]);
  });

  it('clears to transparent after disposal 2', async () => {
    const bytes = buildGif({
      width: 4,
      height: 4,
      palette,
      frames: [
        { w: 4, h: 4, pixels: fill(16, 1), delay: 10, disposal: 2 },
        { x: 1, y: 1, w: 2, h: 2, pixels: fill(4, 2), delay: 10, disposal: 1 },
      ],
    });
    const gif = await decodeGif(bytes.buffer);
    expect(pixel(gif.frames[0].rgba, 4, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(gif.frames[1].rgba, 4, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(gif.frames[1].rgba, 4, 1, 1)).toEqual([0, 255, 0, 255]);
    expect(pixel(gif.frames[1].rgba, 4, 3, 0)).toEqual([0, 0, 0, 0]);
  });

  it('restores the canvas from before a disposal 3 frame, including a prior clear', async () => {
    const bytes = buildGif({
      width: 4,
      height: 4,
      palette,
      frames: [
        { w: 4, h: 4, pixels: fill(16, 1), delay: 5, disposal: 2 },
        { w: 4, h: 4, pixels: fill(16, 3), delay: 5, disposal: 3 },
        { x: 0, y: 0, w: 2, h: 2, pixels: fill(4, 2), delay: 5, disposal: 1 },
      ],
    });
    const gif = await decodeGif(bytes.buffer);
    expect(pixel(gif.frames[0].rgba, 4, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(gif.frames[1].rgba, 4, 3, 3)).toEqual([0, 0, 255, 255]);
    expect(pixel(gif.frames[2].rgba, 4, 0, 0)).toEqual([0, 255, 0, 255]);
    expect(pixel(gif.frames[2].rgba, 4, 3, 3)).toEqual([0, 0, 0, 0]);
  });

  it('restores the previous kept frame after a temporary overlay', async () => {
    const bytes = buildGif({
      width: 2,
      height: 2,
      palette,
      frames: [
        { w: 2, h: 2, pixels: fill(4, 1), disposal: 1 },
        { w: 2, h: 2, pixels: fill(4, 3), disposal: 3 },
        { x: 0, y: 0, w: 1, h: 1, pixels: [2], disposal: 1 },
      ],
    });
    const gif = await decodeGif(bytes.buffer);
    expect(pixel(gif.frames[2].rgba, 2, 0, 0)).toEqual([0, 255, 0, 255]);
    expect(pixel(gif.frames[2].rgba, 2, 1, 1)).toEqual([255, 0, 0, 255]);
  });

  it('leaves existing pixels where the new frame is transparent', async () => {
    const pixels = fill(16, 0);
    pixels[5] = 2;
    pixels[6] = 2;
    pixels[9] = 2;
    pixels[10] = 2;
    const bytes = buildGif({
      width: 4,
      height: 4,
      palette,
      frames: [
        { w: 4, h: 4, pixels: fill(16, 1), disposal: 1 },
        { w: 4, h: 4, pixels, disposal: 1, transparent: 0 },
      ],
    });
    const gif = await decodeGif(bytes.buffer);
    expect(pixel(gif.frames[1].rgba, 4, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(gif.frames[1].rgba, 4, 1, 1)).toEqual([0, 255, 0, 255]);
  });

  it('reads loop counts, including play-once when the extension is absent', async () => {
    const once = await decodeGif(
      buildGif({ width: 1, height: 1, palette, frames: [{ w: 1, h: 1, pixels: [1] }] }).buffer,
    );
    const twice = await decodeGif(
      buildGif({ width: 1, height: 1, loop: 2, palette, frames: [{ w: 1, h: 1, pixels: [1] }] }).buffer,
    );
    expect(once.repeat).toBe(-1);
    expect(twice.repeat).toBe(2);
  });

  it('rejects a file that is not a GIF', async () => {
    const bytes = new TextEncoder().encode('not a gif');
    await expect(decodeGif(bytes.buffer)).rejects.toThrow(/GIF/);
  });
});

describe('sample GIFs', () => {
  it('writes real GIF fixtures used by the repo', async () => {
    const samples = path.join(process.cwd(), 'public', 'samples');
    mkdirSync(samples, { recursive: true });

    const moving = buildGif({
      width: 32,
      height: 32,
      loop: 0,
      palette,
      frames: Array.from({ length: 8 }, (_, frame) => {
        const pixels = fill(32 * 32, 4);
        const x0 = 2 + frame * 3;
        for (let y = 8; y < 24; y++) {
          for (let x = x0; x < x0 + 8 && x < 32; x++) pixels[y * 32 + x] = 1;
        }
        return { w: 32, h: 32, pixels, delay: 8, disposal: 2 };
      }),
    });

    const base = fill(48 * 32, 4);
    for (let x = 0; x < 48; x++) base[x] = 3;
    const partialFrames = [0, 1, 2, 3].map((step) => {
      const pixels = fill(6 * 8, 1);
      return { x: 4 + step * 10, y: 12, w: 6, h: 8, pixels, delay: 12, disposal: step === 0 ? 1 : 1 };
    });
    const partial = buildGif({
      width: 48,
      height: 32,
      loop: 0,
      palette,
      frames: [{ w: 48, h: 32, pixels: base, delay: 12, disposal: 1 }, ...partialFrames],
    });

    const spark = buildGif({
      width: 16,
      height: 16,
      loop: 0,
      palette,
      frames: [
        { w: 16, h: 16, pixels: fill(256, 3), delay: 20, disposal: 1 },
        { x: 4, y: 4, w: 8, h: 8, pixels: fill(64, 5), delay: 8, disposal: 3 },
        { x: 6, y: 6, w: 4, h: 4, pixels: fill(16, 2), delay: 8, disposal: 3 },
        { x: 2, y: 2, w: 3, h: 3, pixels: fill(9, 1), delay: 20, disposal: 1 },
      ],
    });

    const ghostPixels = fill(12 * 12, 0);
    for (let y = 3; y < 9; y++) {
      for (let x = 3; x < 9; x++) ghostPixels[y * 12 + x] = 2;
    }
    const ghost = buildGif({
      width: 12,
      height: 12,
      loop: 0,
      palette,
      frames: [
        { w: 12, h: 12, pixels: fill(144, 1), delay: 15, disposal: 1 },
        { w: 12, h: 12, pixels: ghostPixels, delay: 15, disposal: 1, transparent: 0 },
      ],
    });

    const timed = buildGif({
      width: 8,
      height: 8,
      loop: 0,
      palette,
      frames: [
        { w: 8, h: 8, pixels: fill(64, 1), delay: 0, disposal: 1 },
        { w: 8, h: 8, pixels: fill(64, 2), delay: 10, disposal: 1 },
        { w: 8, h: 8, pixels: fill(64, 3), delay: 50, disposal: 1 },
      ],
    });

    const files = {
      'moving-square.gif': moving,
      'partial-update.gif': partial,
      'restore-previous.gif': spark,
      'transparency.gif': ghost,
      'timed-loop.gif': timed,
    };
    for (const [name, bytes] of Object.entries(files)) {
      writeFileSync(path.join(samples, name), bytes);
      const decoded = await decodeGif(bytes.buffer);
      expect(decoded.frames.length).toBeGreaterThan(0);
      expect(decoded.width).toBeGreaterThan(0);
    }

    const restored = await decodeGif(spark.buffer);
    expect(pixel(restored.frames[0].rgba, 16, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(pixel(restored.frames[1].rgba, 16, 4, 4)).toEqual([255, 255, 0, 255]);
    expect(pixel(restored.frames[3].rgba, 16, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(pixel(restored.frames[3].rgba, 16, 2, 2)).toEqual([255, 0, 0, 255]);
    const timedGif = await decodeGif(timed.buffer);
    expect(timedGif.frames.map((frame) => frame.delayMs)).toEqual([0, 100, 500]);
    expect(timedGif.repeat).toBe(0);
  });
});
