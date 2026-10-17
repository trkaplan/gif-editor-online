import type { Doc, Frame } from '../types';

export function deleteFrames(doc: Doc, ids: readonly string[]): Doc {
  const selected = new Set(ids);
  return { ...doc, frames: doc.frames.filter((frame) => !selected.has(frame.id)) };
}

export function duplicateFrames(doc: Doc, ids: readonly string[], newId: () => string): { doc: Doc; newIds: string[] } {
  const selected = new Set(ids);
  const frames: Frame[] = [];
  const newIds: string[] = [];
  for (const frame of doc.frames) {
    frames.push(frame);
    if (!selected.has(frame.id)) continue;
    const id = newId();
    newIds.push(id);
    frames.push({ ...frame, id });
  }
  return { doc: { ...doc, frames }, newIds };
}

/**
 * Move the selected frames, keeping their relative order, so the group is
 * inserted at `insertAt` in the list of frames that are not moving.
 */
export function moveFrames(doc: Doc, ids: readonly string[], insertAt: number): Doc {
  const selected = new Set(ids);
  const moving = doc.frames.filter((frame) => selected.has(frame.id));
  const rest = doc.frames.filter((frame) => !selected.has(frame.id));
  const at = Math.max(0, Math.min(rest.length, insertAt));
  return { ...doc, frames: [...rest.slice(0, at), ...moving, ...rest.slice(at)] };
}

/** Index into the unselected frames for a drop that sits before `beforeIndex`. */
export function insertSlot(frames: readonly { id: string }[], selected: ReadonlySet<string>, beforeIndex: number): number {
  let count = 0;
  const end = Math.max(0, Math.min(frames.length, beforeIndex));
  for (let i = 0; i < end; i++) {
    if (!selected.has(frames[i].id)) count++;
  }
  return count;
}

export function reverseFrames(doc: Doc, ids: readonly string[]): Doc {
  const selected = new Set(ids);
  const picked = doc.frames.filter((frame) => selected.has(frame.id));
  picked.reverse();
  let cursor = 0;
  return {
    ...doc,
    frames: doc.frames.map((frame) => (selected.has(frame.id) ? picked[cursor++] : frame)),
  };
}

export function setDelay(doc: Doc, ids: readonly string[], delayMs: number): Doc {
  const selected = new Set(ids);
  const delay = Math.max(0, Math.round(delayMs));
  return {
    ...doc,
    frames: doc.frames.map((frame) => (selected.has(frame.id) ? { ...frame, delayMs: delay } : frame)),
  };
}

export function selectionAfterDelete(frames: readonly { id: string }[], ids: readonly string[]): string[] {
  const selected = new Set(ids);
  const first = frames.findIndex((frame) => selected.has(frame.id));
  const keep = frames.filter((frame) => !selected.has(frame.id));
  if (keep.length === 0 || first < 0) return [];
  return [keep[Math.min(first, keep.length - 1)].id];
}

export function rangeIds(frames: readonly { id: string }[], anchor: number, focus: number): string[] {
  if (frames.length === 0) return [];
  const lo = Math.max(0, Math.min(anchor, focus));
  const hi = Math.min(frames.length - 1, Math.max(anchor, focus));
  const focusId = frames[Math.max(0, Math.min(frames.length - 1, focus))].id;
  const ids: string[] = [];
  for (let i = lo; i <= hi; i++) {
    if (frames[i].id !== focusId) ids.push(frames[i].id);
  }
  ids.push(focusId);
  return ids;
}
