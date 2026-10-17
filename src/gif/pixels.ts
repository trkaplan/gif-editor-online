/** Deterministic crop and scale. Canvas smoothing differs across browsers, so export uses this instead. */

export function cropRGBA(
  src: Uint8ClampedArray,
  sw: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y + row) * sw + x) * 4;
    out.set(src.subarray(srcStart, srcStart + w * 4), row * w * 4);
  }
  return out;
}

export function scaleRGBA(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8ClampedArray {
  if (dw < 1 || dh < 1) throw new Error('Invalid size');
  if (dw === sw && dh === sh) return new Uint8ClampedArray(src);
  if (dw <= sw && dh <= sh) return boxDown(src, sw, sh, dw, dh);
  return bilinear(src, sw, sh, dw, dh);
}

function boxDown(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = (y * sh) / dh;
    const y1 = ((y + 1) * sh) / dh;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(sh - 1, Math.ceil(y1) - 1);
    for (let x = 0; x < dw; x++) {
      const x0 = (x * sw) / dw;
      const x1 = ((x + 1) * sw) / dw;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(sw - 1, Math.ceil(x1) - 1);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let wsum = 0;
      for (let iy = iy0; iy <= iy1; iy++) {
        const yCov = Math.min(y1, iy + 1) - Math.max(y0, iy);
        if (yCov <= 0) continue;
        for (let ix = ix0; ix <= ix1; ix++) {
          const xCov = Math.min(x1, ix + 1) - Math.max(x0, ix);
          if (xCov <= 0) continue;
          const weight = xCov * yCov;
          const i = (iy * sw + ix) * 4;
          r += src[i] * weight;
          g += src[i + 1] * weight;
          b += src[i + 2] * weight;
          a += src[i + 3] * weight;
          wsum += weight;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = Math.round(r / wsum);
      out[o + 1] = Math.round(g / wsum);
      out[o + 2] = Math.round(b / wsum);
      out[o + 3] = Math.round(a / wsum);
    }
  }
  return out;
}

function bilinear(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.max(0, Math.min(sh - 1, (y + 0.5) * (sh / dh) - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.max(0, Math.min(sw - 1, (x + 0.5) * (sw / dw) - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = sx - x0;
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = src[(y0 * sw + x0) * 4 + c];
        const p10 = src[(y0 * sw + x1) * 4 + c];
        const p01 = src[(y1 * sw + x0) * 4 + c];
        const p11 = src[(y1 * sw + x1) * 4 + c];
        const top = p00 + (p10 - p00) * tx;
        const bot = p01 + (p11 - p01) * tx;
        out[o + c] = Math.round(top + (bot - top) * ty);
      }
    }
  }
  return out;
}
