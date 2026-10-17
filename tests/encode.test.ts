import { describe, expect, it } from 'vitest';
import { decodeGif } from '../src/gif/decode';
import { encodeGif } from '../src/gif/encode';
import { cropRGBA, scaleRGBA } from '../src/gif/pixels';
import { buildGif, fill, pixel, RED, GREEN, BLUE, BLACK, WHITE } from './gif-builder';

function solid(width: number, height: number, rgba: [number, number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = rgba[0];
    out[i + 1] = rgba[1];
    out[i + 2] = rgba[2];
    out[i + 3] = rgba[3];
  }
  return out;
}

describe('GIF encoder', () => {
  it('round-trips flat frames without edits', async () => {
    const width = 8;
    const height = 6;
    const frames = [
      { rgba: solid(width, height, [255, 0, 0, 255]), delayMs: 100 },
      { rgba: solid(width, height, [0, 255, 0, 255]), delayMs: 250 },
      { rgba: solid(width, height, [0, 0, 255, 255]), delayMs: 40 },
    ];
    const bytes = encodeGif(width, height, frames, { maxColors: 256, dither: 'none', repeat: 0 });
    const again = encodeGif(width, height, frames, { maxColors: 256, dither: 'none', repeat: 0 });
    expect(Buffer.from(bytes).equals(Buffer.from(again))).toBe(true);
    expect(String.fromCharCode(...bytes.slice(0, 6))).toBe('GIF89a');

    const decoded = await decodeGif(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(decoded.repeat).toBe(0);
    expect(decoded.frames.map((frame) => frame.delayMs)).toEqual([100, 250, 40]);
    expect(pixel(decoded.frames[0].rgba, width, 3, 2)).toEqual([255, 0, 0, 255]);
    expect(pixel(decoded.frames[1].rgba, width, 0, 0)).toEqual([0, 255, 0, 255]);
    expect(pixel(decoded.frames[2].rgba, width, 7, 5)).toEqual([0, 0, 255, 255]);
  });

  it('round-trips a decoded GIF that had no pixel edits', async () => {
    const palette = [BLACK, RED, GREEN, BLUE, WHITE, 0xffff00, 0xff00ff, 0x00ffff];
    const source = buildGif({
      width: 5,
      height: 4,
      loop: 0,
      palette,
      frames: [
        { w: 5, h: 4, pixels: fill(20, 1), delay: 10, disposal: 1 },
        { w: 5, h: 4, pixels: fill(20, 2), delay: 20, disposal: 1 },
      ],
    });
    const decoded = await decodeGif(source.buffer);
    const encoded = encodeGif(
      decoded.width,
      decoded.height,
      decoded.frames.map((frame) => ({ rgba: frame.rgba, delayMs: frame.delayMs })),
      { maxColors: 256, dither: 'none', repeat: decoded.repeat },
    );
    const round = await decodeGif(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
    expect(round.frames).toHaveLength(2);
    expect(pixel(round.frames[0].rgba, 5, 2, 1)).toEqual([255, 0, 0, 255]);
    expect(pixel(round.frames[1].rgba, 5, 4, 3)).toEqual([0, 255, 0, 255]);
    expect(round.frames[0].delayMs).toBe(100);
    expect(round.frames[1].delayMs).toBe(200);
  });

  it('keeps a transparent corner transparent', async () => {
    const rgba = solid(4, 4, [0, 0, 255, 255]);
    rgba[3] = 0;
    const bytes = encodeGif(4, 4, [{ rgba, delayMs: 80 }], { maxColors: 16, dither: 'none', repeat: -1 });
    const decoded = await decodeGif(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(decoded.repeat).toBe(-1);
    expect(pixel(decoded.frames[0].rgba, 4, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(decoded.frames[0].rgba, 4, 3, 3)).toEqual([0, 0, 255, 255]);
  });

  it('writes a dithered gradient as a GIF', () => {
    const width = 32;
    const height = 4;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const i = (y * width + x) * 4;
        rgba[i] = Math.round((x / (width - 1)) * 255);
        rgba[i + 1] = 40;
        rgba[i + 2] = 200;
        rgba[i + 3] = 255;
      }
    }
    const bytes = encodeGif(width, height, [{ rgba, delayMs: 100 }], { maxColors: 8, dither: 'floyd', repeat: 0 });
    expect(String.fromCharCode(...bytes.slice(0, 6))).toBe('GIF89a');
    expect(bytes.length).toBeGreaterThan(32);
  });
});

describe('pixel geometry', () => {
  it('crops a sub-rectangle', () => {
    const src = new Uint8ClampedArray(4 * 4 * 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const i = (y * 4 + x) * 4;
        src[i] = x * 10;
        src[i + 1] = y * 10;
        src[i + 2] = 1;
        src[i + 3] = 255;
      }
    }
    const cropped = cropRGBA(src, 4, 1, 2, 2, 2);
    expect(cropped).toHaveLength(16);
    expect([cropped[0], cropped[1]]).toEqual([10, 20]);
    expect([cropped[4], cropped[5]]).toEqual([20, 20]);
  });

  it('scales a solid color without changing it', () => {
    const src = solid(4, 2, [10, 20, 30, 255]);
    const scaled = scaleRGBA(src, 4, 2, 2, 1);
    expect(pixel(scaled, 2, 0, 0)).toEqual([10, 20, 30, 255]);
    expect(pixel(scaled, 2, 1, 0)).toEqual([10, 20, 30, 255]);
  });
});
