import { describe, expect, it } from 'vitest';
import { decodeGif } from '../src/gif/decode';
import { encodeGif } from '../src/gif/encode';
import { pixel } from './gif-builder';

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

describe('delta GIF encoder', () => {
  it('merges a frame that matches the previous one into that frame delay', async () => {
    const frame = solid(6, 4, [20, 40, 60, 255]);
    const bytes = encodeGif(
      6,
      4,
      [
        { rgba: frame, delayMs: 80 },
        { rgba: frame.slice(), delayMs: 120 },
      ],
      { maxColors: 256, dither: 'none', repeat: 0 },
    );
    const decoded = await decodeGif(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(decoded.frames).toHaveLength(1);
    expect(decoded.frames[0].delayMs).toBe(200);
    expect(pixel(decoded.frames[0].rgba, 6, 1, 1)).toEqual([20, 40, 60, 255]);
  });

  it('caps a merged delay at the GIF maximum', async () => {
    const frame = solid(2, 2, [1, 2, 3, 255]);
    const bytes = encodeGif(
      2,
      2,
      [
        { rgba: frame, delayMs: 655350 },
        { rgba: frame.slice(), delayMs: 500 },
      ],
      { maxColors: 16, dither: 'none', repeat: -1 },
    );
    const decoded = await decodeGif(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(decoded.frames).toHaveLength(1);
    expect(decoded.frames[0].delayMs).toBe(655350);
  });

  it('leaves unchanged pixels in place when only a rectangle changes', async () => {
    const width = 8;
    const height = 6;
    const first = solid(width, height, [0, 180, 0, 255]);
    const second = first.slice();
    for (let y = 1; y < 3; y++) {
      for (let x = 2; x < 5; x++) {
        const i = (y * width + x) * 4;
        second[i] = 255;
        second[i + 1] = 0;
        second[i + 2] = 0;
      }
    }
    const bytes = encodeGif(
      width,
      height,
      [
        { rgba: first, delayMs: 100 },
        { rgba: second, delayMs: 100 },
      ],
      { maxColors: 256, dither: 'none', repeat: 0 },
    );
    const decoded = await decodeGif(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(decoded.frames).toHaveLength(2);
    expect(pixel(decoded.frames[1].rgba, width, 2, 1)).toEqual([255, 0, 0, 255]);
    expect(pixel(decoded.frames[1].rgba, width, 0, 0)).toEqual([0, 180, 0, 255]);
    expect(pixel(decoded.frames[1].rgba, width, 7, 5)).toEqual([0, 180, 0, 255]);
  });

  it('encodes a moving square far smaller than a full-frame GIF', { timeout: 180_000 }, () => {
    const width = 400;
    const height = 300;
    const frames = [];
    for (let frame = 0; frame < 20; frame++) {
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const n = (x * 13 + y * 29) & 255;
          rgba[i] = n;
          rgba[i + 1] = (n * 5) & 255;
          rgba[i + 2] = (x * 3 + y) & 255;
          rgba[i + 3] = 255;
        }
      }
      const origin = frame * 10;
      for (let y = 0; y < 20; y++) {
        for (let x = 0; x < 20; x++) {
          const i = ((y + 8) * width + (x + origin)) * 4;
          rgba[i] = 255;
          rgba[i + 1] = 0;
          rgba[i + 2] = 0;
        }
      }
      frames.push({ rgba, delayMs: 50 });
    }
    const options = { maxColors: 256, dither: 'none' as const, repeat: 0 };
    const delta = encodeGif(width, height, frames, options);
    const full = encodeGif(width, height, frames, { ...options, fullFrame: true });
    expect(delta.byteLength).toBeLessThan(full.byteLength * 0.1);
  });
});
