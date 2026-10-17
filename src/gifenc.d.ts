declare module 'gifenc' {
  export interface WriteFrameOpts {
    palette?: number[][];
    first?: boolean;
    transparent?: boolean;
    transparentIndex?: number;
    delay?: number;
    repeat?: number;
    dispose?: number;
    colorDepth?: number;
  }

  export interface Encoder {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: WriteFrameOpts): void;
    finish(): void;
    bytes(): Uint8Array;
  }

  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): Encoder;

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: {
      format?: 'rgb565' | 'rgb444' | 'rgba4444';
      oneBitAlpha?: boolean | number;
      clearAlpha?: boolean;
      clearAlphaThreshold?: number;
      clearAlphaColor?: number;
    },
  ): number[][];

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array;

  export function nearestColorIndex(colors: number[][], pixel: number[]): number;
}
