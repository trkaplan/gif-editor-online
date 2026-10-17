import type { Annotation } from './types';

export interface DecodeStart {
  type: 'decode-start';
  job: number;
  width: number;
  height: number;
  repeat: number;
  total: number;
}

export interface DecodeFrameMsg {
  type: 'decode-frame';
  job: number;
  index: number;
  total: number;
  delayMs: number;
  pixels: ArrayBuffer;
  thumb: ArrayBuffer;
}

export interface DecodeDone {
  type: 'decode-done';
  job: number;
}

export interface EncodeProgress {
  type: 'encode-progress';
  job: number;
  index: number;
  total: number;
}

export interface EncodeDone {
  type: 'encode-done';
  job: number;
  buffer: ArrayBuffer;
}

export interface TransformDone {
  type: 'transform-done';
  job: number;
  width: number;
  height: number;
  frames: { id: string; pixels: ArrayBuffer; thumb: ArrayBuffer }[];
}

export interface ErrorMsg {
  type: 'error';
  job: number;
  message: string;
}

export type OutMessage = DecodeStart | DecodeFrameMsg | DecodeDone | EncodeProgress | EncodeDone | TransformDone | ErrorMsg;

export interface EncodeInFrame {
  delayMs: number;
  pixels: ArrayBuffer;
  annotations?: Annotation[];
}

export type InMessage =
  | { type: 'decode'; job: number; buffer: ArrayBuffer }
  | {
      type: 'encode';
      job: number;
      width: number;
      height: number;
      repeat: number;
      maxColors: number;
      dither: 'none' | 'floyd';
      scale: number;
      frames: EncodeInFrame[];
    }
  | {
      type: 'transform';
      job: number;
      op: 'crop' | 'resize' | 'annotate';
      width: number;
      height: number;
      frames: { id: string; pixels: ArrayBuffer; annotations?: Annotation[] }[];
      crop?: { x: number; y: number; w: number; h: number };
      targetWidth?: number;
      targetHeight?: number;
      annotations?: Annotation[];
    };
