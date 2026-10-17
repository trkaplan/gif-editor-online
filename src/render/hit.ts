import type { Annotation, Rect } from '../types';
import { FONT_FAMILY } from '../types';
import { normalizeRect } from '../util';

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

let measureTextWidth = (text: string, fontSize: number) => Math.max(8, (text || ' ').length * fontSize * 0.55);

export function setTextMeasurer(fn: (text: string, fontSize: number) => number): void {
  measureTextWidth = fn;
}

export function textWidth(text: string, fontSize: number): number {
  return measureTextWidth(text, fontSize);
}

export function boundsOf(annotation: Annotation): Bounds {
  switch (annotation.type) {
    case 'arrow': {
      const x = Math.min(annotation.x1, annotation.x2);
      const y = Math.min(annotation.y1, annotation.y2);
      return {
        x,
        y,
        w: Math.max(1, Math.abs(annotation.x2 - annotation.x1)),
        h: Math.max(1, Math.abs(annotation.y2 - annotation.y1)),
      };
    }
    case 'pen': {
      if (annotation.points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const point of annotation.points) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
      return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
    }
    case 'text': {
      const width = Math.max(8, textWidth(annotation.text || ' ', annotation.fontSize));
      return { x: annotation.x, y: annotation.y, w: width, h: annotation.fontSize * 1.25 };
    }
    default: {
      const rect = normalizeRect(annotation.x, annotation.y, annotation.w, annotation.h);
      return { x: rect.x, y: rect.y, w: Math.max(1, rect.w), h: Math.max(1, rect.h) };
    }
  }
}

export function hitTest(
  annotations: readonly Annotation[],
  x: number,
  y: number,
  handle: number,
): { id: string; handle: string } | null {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const annotation = annotations[i];
    for (const point of handlePoints(annotation, handle)) {
      if (Math.abs(x - point.x) <= handle && Math.abs(y - point.y) <= handle) {
        return { id: annotation.id, handle: point.name };
      }
    }
  }
  for (let i = annotations.length - 1; i >= 0; i--) {
    if (hitsBody(annotations[i], x, y, handle)) return { id: annotations[i].id, handle: 'body' };
  }
  return null;
}

export function handlePoints(annotation: Annotation, handle: number): { name: string; x: number; y: number }[] {
  if (annotation.type === 'arrow') {
    return [
      { name: 'start', x: annotation.x1, y: annotation.y1 },
      { name: 'end', x: annotation.x2, y: annotation.y2 },
    ];
  }
  const bounds = boundsOf(annotation);
  const right = bounds.x + bounds.w;
  const bottom = bounds.y + bounds.h;
  const midX = bounds.x + bounds.w / 2;
  const midY = bounds.y + bounds.h / 2;
  void handle;
  return [
    { name: 'nw', x: bounds.x, y: bounds.y },
    { name: 'n', x: midX, y: bounds.y },
    { name: 'ne', x: right, y: bounds.y },
    { name: 'e', x: right, y: midY },
    { name: 'se', x: right, y: bottom },
    { name: 's', x: midX, y: bottom },
    { name: 'sw', x: bounds.x, y: bottom },
    { name: 'w', x: bounds.x, y: midY },
  ];
}

function hitsBody(annotation: Annotation, x: number, y: number, pad: number): boolean {
  if (annotation.type === 'arrow') {
    return distToSegment(x, y, annotation.x1, annotation.y1, annotation.x2, annotation.y2) <= Math.max(pad, annotation.strokeWidth + 4);
  }
  if (annotation.type === 'pen') {
    const points = annotation.points;
    if (points.length === 0) return false;
    const threshold = Math.max(pad, annotation.strokeWidth + 4);
    if (points.length === 1) return Math.hypot(x - points[0].x, y - points[0].y) <= threshold;
    for (let i = 1; i < points.length; i++) {
      if (distToSegment(x, y, points[i - 1].x, points[i - 1].y, points[i].x, points[i].y) <= threshold) return true;
    }
    return false;
  }
  const bounds = boundsOf(annotation);
  return x >= bounds.x - pad && y >= bounds.y - pad && x <= bounds.x + bounds.w + pad && y <= bounds.y + bounds.h + pad;
}

export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function translateAnnotation(annotation: Annotation, dx: number, dy: number): Annotation {
  switch (annotation.type) {
    case 'arrow':
      return { ...annotation, x1: annotation.x1 + dx, y1: annotation.y1 + dy, x2: annotation.x2 + dx, y2: annotation.y2 + dy };
    case 'pen':
      return { ...annotation, points: annotation.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) };
    default:
      return { ...annotation, x: annotation.x + dx, y: annotation.y + dy };
  }
}

export function resizeAnnotation(annotation: Annotation, handle: string, x: number, y: number): Annotation {
  if (annotation.type === 'arrow') {
    if (handle === 'start') return { ...annotation, x1: x, y1: y };
    if (handle === 'end') return { ...annotation, x2: x, y2: y };
    return annotation;
  }
  if (annotation.type === 'pen') {
    const bounds = boundsOf(annotation);
    const next = resizeBounds(bounds, handle, x, y);
    if (bounds.w === 0 || bounds.h === 0) return annotation;
    return {
      ...annotation,
      points: annotation.points.map((point) => ({
        x: next.x + ((point.x - bounds.x) / bounds.w) * next.w,
        y: next.y + ((point.y - bounds.y) / bounds.h) * next.h,
      })),
    };
  }
  if (annotation.type === 'text') {
    const bounds = boundsOf(annotation);
    const next = resizeBounds(bounds, handle, x, y);
    let fontSize = annotation.fontSize;
    if (handle === 'e' || handle === 'w') {
      if (bounds.w > 0) fontSize = Math.max(8, Math.round(annotation.fontSize * (next.w / bounds.w)));
    } else {
      fontSize = Math.max(8, Math.round(next.h / 1.25));
    }
    return { ...annotation, x: next.x, y: next.y, fontSize };
  }
  const current = normalizeRect(annotation.x, annotation.y, annotation.w, annotation.h);
  const next = resizeBounds(current, handle, x, y);
  return { ...annotation, ...next };
}

function resizeBounds(bounds: Bounds, handle: string, x: number, y: number): Rect {
  let x1 = bounds.x;
  let y1 = bounds.y;
  let x2 = bounds.x + bounds.w;
  let y2 = bounds.y + bounds.h;
  if (handle === 'nw' || handle === 'n' || handle === 'ne') y1 = y;
  if (handle === 'sw' || handle === 's' || handle === 'se') y2 = y;
  if (handle === 'nw' || handle === 'w' || handle === 'sw') x1 = x;
  if (handle === 'ne' || handle === 'e' || handle === 'se') x2 = x;
  const rect = normalizeRect(x1, y1, x2 - x1, y2 - y1);
  return { x: rect.x, y: rect.y, w: Math.max(1, rect.w), h: Math.max(1, rect.h) };
}

export function isDrawable(annotation: Annotation): boolean {
  if (annotation.type === 'rect' || annotation.type === 'highlight' || annotation.type === 'blur') {
    const rect = normalizeRect(annotation.x, annotation.y, annotation.w, annotation.h);
    return rect.w >= 2 && rect.h >= 2;
  }
  if (annotation.type === 'arrow') {
    const dx = annotation.x2 - annotation.x1;
    const dy = annotation.y2 - annotation.y1;
    return dx * dx + dy * dy >= 4;
  }
  if (annotation.type === 'pen') return annotation.points.length >= 2;
  if (annotation.type === 'text') return annotation.text.trim().length > 0;
  return true;
}

export function fontCss(fontSize: number): string {
  return `${fontSize}px ${FONT_FAMILY}`;
}
