import { describe, expect, it } from 'vitest';
import type { Doc, Frame } from '../src/types';
import { deleteFrames, duplicateFrames, insertSlot, moveFrames, rangeIds, reverseFrames, selectionAfterDelete, setDelay } from '../src/model/edits';
import { History } from '../src/model/history';
import type { RectAnn, TextAnn } from '../src/types';
import {
  annotationsOnFrame,
  assignAnnotationFrames,
  cloneAnnotationsForDuplicates,
  cropAnnotations,
  dropFrameIds,
  scaleAnnotations,
} from '../src/model/annotations';
import { hitTest, resizeAnnotation, translateAnnotation } from '../src/render/hit';

function frame(id: string, delayMs = 100): Frame {
  return { id, delayMs, pixels: new Blob([id]), thumb: new Blob([`${id}-t`]) };
}

function doc(ids: string[]): Doc {
  return { width: 2, height: 2, repeat: 0, name: 't.gif', frames: ids.map((id) => frame(id)) };
}

describe('frame edits', () => {
  it('deletes, duplicates, and restores delays through undo', () => {
    const history = new History({ doc: doc(['a', 'b', 'c', 'd']), annotations: [], selectedIds: ['b'] });
    const start = history.undo();
    expect(start).toBeNull();

    let current = doc(['a', 'b', 'c', 'd']);
    current = setDelay(current, ['b', 'c'], 40);
    history.commit({ doc: current, annotations: [], selectedIds: ['b', 'c'] });
    const duplicated = duplicateFrames(current, ['b'], () => 'b2');
    current = duplicated.doc;
    history.commit({ doc: current, annotations: [], selectedIds: duplicated.newIds });
    expect(current.frames.map((item) => item.id)).toEqual(['a', 'b', 'b2', 'c', 'd']);
    expect(current.frames[2].pixels).toBe(current.frames[1].pixels);
    expect(current.frames[1].delayMs).toBe(40);

    current = deleteFrames(current, ['a', 'd']);
    history.commit({ doc: current, annotations: [], selectedIds: selectionAfterDelete(doc(['a', 'b', 'b2', 'c', 'd']).frames, ['a', 'd']) });
    expect(current.frames.map((item) => item.id)).toEqual(['b', 'b2', 'c']);

    const undone = history.undo();
    expect(undone?.doc?.frames.map((item) => item.id)).toEqual(['a', 'b', 'b2', 'c', 'd']);
    const again = history.undo();
    expect(again?.doc?.frames.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(again?.doc?.frames[1].delayMs).toBe(40);
    const redone = history.redo();
    expect(redone?.doc?.frames.map((item) => item.id)).toEqual(['a', 'b', 'b2', 'c', 'd']);
    expect(history.canRedo).toBe(true);
  });

  it('moves and reverses only the selection', () => {
    const source = doc(['a', 'b', 'c', 'd']);
    const selected = new Set(['b', 'c']);
    expect(insertSlot(source.frames, selected, 4)).toBe(2);
    expect(moveFrames(source, ['b', 'c'], 2).frames.map((item) => item.id)).toEqual(['a', 'd', 'b', 'c']);
    expect(moveFrames(source, ['b'], 0).frames.map((item) => item.id)).toEqual(['b', 'a', 'c', 'd']);
    expect(reverseFrames(source, ['b', 'd']).frames.map((item) => item.id)).toEqual(['a', 'd', 'c', 'b']);
    expect(rangeIds(source.frames, 1, 3)).toEqual(['b', 'c', 'd']);
    expect(selectionAfterDelete(source.frames, ['b'])).toEqual(['c']);
    expect(selectionAfterDelete(source.frames, ['d'])).toEqual(['c']);
  });

  it('drops the oldest snapshot past the limit and clears redo on a new edit', () => {
    const history = new History({ doc: doc(['a']), annotations: [], selectedIds: ['a'] });
    for (let i = 0; i < 60; i++) {
      history.commit({ doc: doc([`f${i}`]), annotations: [], selectedIds: [`f${i}`] });
    }
    let steps = 0;
    while (history.undo()) steps++;
    expect(steps).toBe(50);
    history.redo();
    history.commit({ doc: doc(['z']), annotations: [], selectedIds: ['z'] });
    expect(history.canRedo).toBe(false);
  });
});

describe('annotation geometry', () => {
  const rect: RectAnn = { id: 'r', type: 'rect', x: 10, y: 20, w: 30, h: 40, color: '#fff', strokeWidth: 2 };

  it('hits the body and a corner, then moves and resizes', () => {
    expect(hitTest([rect], 15, 25, 4)?.handle).toBe('body');
    expect(hitTest([rect], 10, 20, 4)?.handle).toBe('nw');
    expect(hitTest([rect], 0, 0, 4)).toBeNull();
    const moved = translateAnnotation(rect, 5, -4);
    expect(moved).toMatchObject({ x: 15, y: 16 });
    const resized = resizeAnnotation(rect, 'se', 50, 80);
    expect(resized).toMatchObject({ x: 10, y: 20, w: 40, h: 60 });
    const flipped = resizeAnnotation(rect, 'nw', 50, 70);
    expect(flipped).toMatchObject({ x: 40, y: 60 });
  });

  it('resizes text from the box instead of only moving it', () => {
    const text: TextAnn = { id: 't', type: 'text', x: 10, y: 20, text: 'Hi', fontSize: 16, color: '#fff', background: false };
    const resized = resizeAnnotation(text, 'se', 80, 60);
    expect(resized).toMatchObject({ type: 'text', x: 10, y: 20 });
    if (resized.type === 'text') expect(resized.fontSize).toBeGreaterThan(16);
  });
});

describe('editable drawings', () => {
  const arrow = { id: 'a', type: 'arrow' as const, x1: 0, y1: 0, x2: 10, y2: 10, color: '#fff', strokeWidth: 2 };
  const rect = { id: 'r', type: 'rect' as const, x: 5, y: 5, w: 10, h: 10, color: '#fff', strokeWidth: 2, frameIds: ['b'] };

  it('keeps drafts on every frame and limits a drawing after apply', () => {
    expect(annotationsOnFrame([arrow], 'a')).toHaveLength(1);
    expect(annotationsOnFrame([rect], 'a')).toHaveLength(0);
    expect(annotationsOnFrame([rect], 'b')).toHaveLength(1);
    const placed = assignAnnotationFrames([arrow], ['a', 'c'], null);
    expect(placed[0].frameIds).toEqual(['a', 'c']);
    const again = assignAnnotationFrames(placed, ['b'], 'a');
    expect(again[0]).toMatchObject({ frameIds: ['b'], x1: 0 });
  });

  it('drops, clones, crops, and scales drawings without baking them', () => {
    expect(dropFrameIds([rect, arrow], new Set(['b'])).map((item) => item.id)).toEqual(['a']);
    const cloned = cloneAnnotationsForDuplicates([rect], ['b'], ['b2'], () => 'r2');
    expect(cloned.map((item) => item.id)).toEqual(['r', 'r2']);
    expect(cloned[1].frameIds).toEqual(['b2']);
    const cropped = cropAnnotations([{ ...rect, frameIds: undefined }, { ...rect, id: 'out', x: 40, y: 40 }], { x: 4, y: 4, w: 8, h: 8 });
    expect(cropped).toHaveLength(1);
    expect(cropped[0]).toMatchObject({ id: 'r', x: 1, y: 1, w: 10, h: 10 });
    const scaled = scaleAnnotations([rect], 2, 3);
    expect(scaled[0]).toMatchObject({ x: 10, y: 15, w: 20, h: 30, strokeWidth: 5 });
  });
});
