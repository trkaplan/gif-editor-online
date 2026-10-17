import type { Annotation } from '../types';
import { normalizeRect } from '../util';
import { fontCss, textWidth } from './hit';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawAnnotations(ctx: Ctx, annotations: readonly Annotation[], skipId?: string | null): void {
  for (const annotation of annotations) {
    if (annotation.type === 'blur' && annotation.id !== skipId) drawBlur(ctx, annotation);
  }
  for (const annotation of annotations) {
    if (annotation.type === 'highlight' && annotation.id !== skipId) drawHighlight(ctx, annotation);
  }
  for (const annotation of annotations) {
    if (annotation.id === skipId) continue;
    if (annotation.type === 'blur' || annotation.type === 'highlight') continue;
    drawShape(ctx, annotation);
  }
}

export function drawShape(ctx: Ctx, annotation: Annotation): void {
  switch (annotation.type) {
    case 'arrow':
      drawArrow(ctx, annotation.x1, annotation.y1, annotation.x2, annotation.y2, annotation.color, annotation.strokeWidth);
      break;
    case 'rect': {
      const rect = normalizeRect(annotation.x, annotation.y, annotation.w, annotation.h);
      ctx.save();
      ctx.strokeStyle = annotation.color;
      ctx.lineWidth = annotation.strokeWidth;
      ctx.lineJoin = 'round';
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      ctx.restore();
      break;
    }
    case 'pen':
      drawPen(ctx, annotation.points, annotation.color, annotation.strokeWidth);
      break;
    case 'text':
      drawText(ctx, annotation);
      break;
    default:
      break;
  }
}

function drawArrow(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, color: string, strokeWidth: number): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const head = Math.min(len * 0.45, Math.max(10, strokeWidth * 4));
  const ux = dx / len;
  const uy = dy / len;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2 - ux * head * 0.55, y2 - uy * head * 0.55);
  ctx.stroke();
  const angle = Math.atan2(dy, dx);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawPen(ctx: Ctx, points: { x: number; y: number }[], color: string, strokeWidth: number): void {
  if (points.length === 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  if (points.length === 1) ctx.lineTo(points[0].x + 0.1, points[0].y);
  ctx.stroke();
  ctx.restore();
}

function drawText(ctx: Ctx, annotation: Extract<Annotation, { type: 'text' }>): void {
  const text = annotation.text || '';
  if (!text) return;
  ctx.save();
  ctx.font = fontCss(annotation.fontSize);
  ctx.textBaseline = 'top';
  const width = Math.max(ctx.measureText(text).width, textWidth(text, annotation.fontSize));
  const height = annotation.fontSize * 1.25;
  if (annotation.background) {
    ctx.fillStyle = textIsDark(annotation.color) ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.72)';
    ctx.fillRect(annotation.x - 4, annotation.y - 2, width + 8, height + 4);
  }
  ctx.fillStyle = annotation.color;
  ctx.fillText(text, annotation.x, annotation.y);
  ctx.restore();
}

function drawHighlight(ctx: Ctx, annotation: Extract<Annotation, { type: 'highlight' }>): void {
  const rect = normalizeRect(annotation.x, annotation.y, annotation.w, annotation.h);
  ctx.save();
  ctx.fillStyle = 'rgba(255, 214, 0, 0.45)';
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

function drawBlur(ctx: Ctx, annotation: Extract<Annotation, { type: 'blur' }>): void {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const rect = clampRect(annotation.x, annotation.y, annotation.w, annotation.h, width, height);
  if (rect.w < 1 || rect.h < 1) return;
  const image = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
  boxBlur(image.data, rect.w, rect.h, Math.max(1, annotation.radius), 2);
  ctx.putImageData(image, rect.x, rect.y);
}

export function drawHandles(ctx: Ctx, annotation: Annotation, handle: number): void {
  ctx.save();
  ctx.strokeStyle = '#2563eb';
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = Math.max(1, handle / 6);
  if (annotation.type === 'arrow') {
    ctx.beginPath();
    ctx.moveTo(annotation.x1, annotation.y1);
    ctx.lineTo(annotation.x2, annotation.y2);
    ctx.stroke();
  } else {
    const bounds = boundsFromAnnotation(annotation);
    ctx.strokeRect(bounds.x, bounds.y, bounds.w, bounds.h);
  }
  for (const point of handlePointsOf(annotation)) {
    ctx.fillRect(point.x - handle / 2, point.y - handle / 2, handle, handle);
    ctx.strokeRect(point.x - handle / 2, point.y - handle / 2, handle, handle);
  }
  ctx.restore();
}

function handlePointsOf(annotation: Annotation): { x: number; y: number }[] {
  if (annotation.type === 'arrow') {
    return [
      { x: annotation.x1, y: annotation.y1 },
      { x: annotation.x2, y: annotation.y2 },
    ];
  }
  const bounds = boundsFromAnnotation(annotation);
  const right = bounds.x + bounds.w;
  const bottom = bounds.y + bounds.h;
  return [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.w / 2, y: bounds.y },
    { x: right, y: bounds.y },
    { x: right, y: bounds.y + bounds.h / 2 },
    { x: right, y: bottom },
    { x: bounds.x + bounds.w / 2, y: bottom },
    { x: bounds.x, y: bottom },
    { x: bounds.x, y: bounds.y + bounds.h / 2 },
  ];
}

function boundsFromAnnotation(annotation: Annotation): { x: number; y: number; w: number; h: number } {
  if (annotation.type === 'pen') {
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
  if (annotation.type === 'text') {
    return { x: annotation.x, y: annotation.y, w: Math.max(8, textWidth(annotation.text || ' ', annotation.fontSize)), h: annotation.fontSize * 1.25 };
  }
  if (annotation.type === 'arrow') {
    return {
      x: Math.min(annotation.x1, annotation.x2),
      y: Math.min(annotation.y1, annotation.y2),
      w: Math.abs(annotation.x2 - annotation.x1),
      h: Math.abs(annotation.y2 - annotation.y1),
    };
  }
  return normalizeRect(annotation.x, annotation.y, annotation.w, annotation.h);
}

export function drawCropOverlay(ctx: Ctx, crop: { x: number; y: number; w: number; h: number }): void {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const rect = normalizeRect(crop.x, crop.y, crop.w, crop.h);
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.fill('evenodd');
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1, width / 400);
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

function textIsDark(color: string): boolean {
  const hex = color.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return false;
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 < 150;
}

function clampRect(x: number, y: number, w: number, h: number, cw: number, ch: number): { x: number; y: number; w: number; h: number } {
  const rect = normalizeRect(x, y, w, h);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(cw, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(ch, Math.ceil(rect.y + rect.h));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

function boxBlur(data: Uint8ClampedArray, width: number, height: number, radius: number, passes: number): void {
  const tmp = new Uint8ClampedArray(data.length);
  for (let pass = 0; pass < passes; pass++) {
    blurAxis(data, tmp, width, height, radius, true);
    blurAxis(tmp, data, width, height, radius, false);
  }
}

function blurAxis(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
): void {
  const window = radius * 2 + 1;
  if (horizontal) {
    for (let y = 0; y < height; y++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let x = -radius; x <= radius; x++) {
        const sample = (y * width + clampIndex(x, width)) * 4;
        r += src[sample];
        g += src[sample + 1];
        b += src[sample + 2];
        a += src[sample + 3];
      }
      for (let x = 0; x < width; x++) {
        const dest = (y * width + x) * 4;
        dst[dest] = Math.round(r / window);
        dst[dest + 1] = Math.round(g / window);
        dst[dest + 2] = Math.round(b / window);
        dst[dest + 3] = Math.round(a / window);
        const add = (y * width + clampIndex(x + radius + 1, width)) * 4;
        const sub = (y * width + clampIndex(x - radius, width)) * 4;
        r += src[add] - src[sub];
        g += src[add + 1] - src[sub + 1];
        b += src[add + 2] - src[sub + 2];
        a += src[add + 3] - src[sub + 3];
      }
    }
    return;
  }
  for (let x = 0; x < width; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let y = -radius; y <= radius; y++) {
      const sample = (clampIndex(y, height) * width + x) * 4;
      r += src[sample];
      g += src[sample + 1];
      b += src[sample + 2];
      a += src[sample + 3];
    }
    for (let y = 0; y < height; y++) {
      const dest = (y * width + x) * 4;
      dst[dest] = Math.round(r / window);
      dst[dest + 1] = Math.round(g / window);
      dst[dest + 2] = Math.round(b / window);
      dst[dest + 3] = Math.round(a / window);
      const add = (clampIndex(y + radius + 1, height) * width + x) * 4;
      const sub = (clampIndex(y - radius, height) * width + x) * 4;
      r += src[add] - src[sub];
      g += src[add + 1] - src[sub + 1];
      b += src[add + 2] - src[sub + 2];
      a += src[add + 3] - src[sub + 3];
    }
  }
}

function clampIndex(index: number, size: number): number {
  if (index < 0) return 0;
  if (index >= size) return size - 1;
  return index;
}
