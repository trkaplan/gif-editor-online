import type { Annotation, Rect } from '../types';
import { boundsOf, translateAnnotation } from '../render/hit';
import { normalizeRect } from '../util';

/** A drawing with no frame list is a draft and shows on every frame. */
export function annotationsOnFrame(annotations: readonly Annotation[], frameId: string): Annotation[] {
  return annotations.filter((annotation) => !annotation.frameIds?.length || annotation.frameIds.includes(frameId));
}

/**
 * Place draft drawings on `frameIds`. If nothing is still a draft, retarget the
 * selected drawing, or every drawing when none is selected. Objects stay editable.
 */
export function assignAnnotationFrames(
  annotations: readonly Annotation[],
  frameIds: readonly string[],
  selectedId: string | null,
): Annotation[] {
  const ids = [...frameIds];
  const draftIds = new Set(annotations.filter((annotation) => !annotation.frameIds?.length).map((annotation) => annotation.id));
  if (draftIds.size > 0) {
    return annotations.map((annotation) => (draftIds.has(annotation.id) ? { ...annotation, frameIds: ids } : annotation));
  }
  if (selectedId && annotations.some((annotation) => annotation.id === selectedId)) {
    return annotations.map((annotation) => (annotation.id === selectedId ? { ...annotation, frameIds: ids } : annotation));
  }
  return annotations.map((annotation) => ({ ...annotation, frameIds: ids }));
}

export function sameFrameIds(left?: readonly string[], right?: readonly string[]): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Drop drawings that lived only on removed frames. Drafts stay on the remaining frames. */
export function dropFrameIds(annotations: readonly Annotation[], removed: ReadonlySet<string>): Annotation[] {
  const next: Annotation[] = [];
  for (const annotation of annotations) {
    if (!annotation.frameIds?.length) {
      next.push(annotation);
      continue;
    }
    const frameIds = annotation.frameIds.filter((id) => !removed.has(id));
    if (frameIds.length === 0) continue;
    next.push(frameIds.length === annotation.frameIds.length ? annotation : { ...annotation, frameIds });
  }
  return next;
}

/**
 * Copy drawings onto duplicated frames so each copy can be edited on its own.
 * Drafts already show on every frame, including the new ones.
 */
export function cloneAnnotationsForDuplicates(
  annotations: readonly Annotation[],
  sourceIds: readonly string[],
  newIds: readonly string[],
  newAnnotationId: () => string,
): Annotation[] {
  const map = new Map<string, string>();
  sourceIds.forEach((id, index) => {
    const created = newIds[index];
    if (created) map.set(id, created);
  });
  const clones: Annotation[] = [];
  for (const annotation of annotations) {
    if (!annotation.frameIds?.length) continue;
    const frameIds = annotation.frameIds.flatMap((id) => {
      const created = map.get(id);
      return created ? [created] : [];
    });
    if (frameIds.length === 0) continue;
    clones.push({ ...structuredClone(annotation), id: newAnnotationId(), frameIds });
  }
  return clones.length === 0 ? [...annotations] : [...annotations, ...clones];
}

export function cropAnnotations(annotations: readonly Annotation[], crop: Rect): Annotation[] {
  const area = normalizeRect(crop.x, crop.y, crop.w, crop.h);
  const next: Annotation[] = [];
  for (const annotation of annotations) {
    const moved = translateAnnotation(normalizeDrawn(annotation), -area.x, -area.y);
    const bounds = boundsOf(moved);
    if (bounds.w <= 0 || bounds.h <= 0) continue;
    if (bounds.x >= area.w || bounds.y >= area.h || bounds.x + bounds.w <= 0 || bounds.y + bounds.h <= 0) continue;
    next.push(moved);
  }
  return next;
}

export function scaleAnnotations(annotations: readonly Annotation[], sx: number, sy: number): Annotation[] {
  return annotations.map((annotation) => scaleAnnotation(annotation, sx, sy));
}

function scaleAnnotation(annotation: Annotation, sx: number, sy: number): Annotation {
  const stroke = (value: number) => Math.max(1, Math.round(value * ((sx + sy) / 2)));
  switch (annotation.type) {
    case 'arrow':
      return {
        ...annotation,
        x1: annotation.x1 * sx,
        y1: annotation.y1 * sy,
        x2: annotation.x2 * sx,
        y2: annotation.y2 * sy,
        strokeWidth: stroke(annotation.strokeWidth),
      };
    case 'pen':
      return {
        ...annotation,
        points: annotation.points.map((point) => ({ x: point.x * sx, y: point.y * sy })),
        strokeWidth: stroke(annotation.strokeWidth),
      };
    case 'text':
      return { ...annotation, x: annotation.x * sx, y: annotation.y * sy, fontSize: Math.max(8, Math.round(annotation.fontSize * sy)) };
    case 'blur':
      return {
        ...annotation,
        ...scaleRect(annotation, sx, sy),
        radius: Math.max(1, Math.round(annotation.radius * ((sx + sy) / 2))),
      };
    case 'rect':
      return { ...annotation, ...scaleRect(annotation, sx, sy), strokeWidth: stroke(annotation.strokeWidth) };
    default:
      return { ...annotation, ...scaleRect(annotation, sx, sy) };
  }
}

function scaleRect(annotation: { x: number; y: number; w: number; h: number }, sx: number, sy: number): Rect {
  const rect = normalizeRect(annotation.x, annotation.y, annotation.w, annotation.h);
  return { x: rect.x * sx, y: rect.y * sy, w: Math.max(1, rect.w * sx), h: Math.max(1, rect.h * sy) };
}

function normalizeDrawn(annotation: Annotation): Annotation {
  if (annotation.type === 'rect' || annotation.type === 'highlight' || annotation.type === 'blur') {
    return { ...annotation, ...normalizeRect(annotation.x, annotation.y, annotation.w, annotation.h) };
  }
  return annotation;
}
