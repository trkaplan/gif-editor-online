declare module 'omggif' {
  export class GifWriter {
    constructor(
      buf: number[],
      width: number,
      height: number,
      opts?: { loop?: number; palette?: number[] },
    );
    addFrame(
      x: number,
      y: number,
      w: number,
      h: number,
      indexed: Uint8Array | number[],
      opts?: { delay?: number; disposal?: number; palette?: number[]; transparent?: number },
    ): number;
    end(): number;
  }
}
