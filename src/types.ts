/**
 * A frame is one full composited image, as it looks while the GIF plays.
 * `pixels` is raw RGBA compressed with deflate. Blobs are immutable and may
 * be shared by duplicated frames until one of them is redrawn.
 * A screen recorder can append the same frame records later without the decoder.
 */
export interface Frame {
  id: string;
  delayMs: number;
  pixels: Blob;
  thumb: Blob;
}

export interface Doc {
  width: number;
  height: number;
  /** Netscape repeat: -1 play once, 0 forever, N extra loops. */
  repeat: number;
  name: string;
  frames: Frame[];
}

export type Tool =
  | 'select'
  | 'arrow'
  | 'rect'
  | 'pen'
  | 'text'
  | 'highlight'
  | 'blur'
  | 'crop';

export interface ArrowAnn {
  id: string;
  type: 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  strokeWidth: number;
}

export interface RectAnn {
  id: string;
  type: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  strokeWidth: number;
}

export interface PenAnn {
  id: string;
  type: 'pen';
  points: { x: number; y: number }[];
  color: string;
  strokeWidth: number;
}

export interface TextAnn {
  id: string;
  type: 'text';
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color: string;
  background: boolean;
}

export interface HighlightAnn {
  id: string;
  type: 'highlight';
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BlurAnn {
  id: string;
  type: 'blur';
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
}

export type Annotation = (ArrowAnn | RectAnn | PenAnn | TextAnn | HighlightAnn | BlurAnn) & {
  /** Missing while the drawing is a draft shown on every frame. Apply stores the frame ids and leaves the drawing editable. */
  frameIds?: string[];
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const BLUR_RADIUS = 8;
export const FONT_FAMILY = 'sans-serif';
