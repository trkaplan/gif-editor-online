import type { Annotation, Doc } from '../types';

export interface Snapshot {
  doc: Doc | null;
  annotations: Annotation[];
  selectedIds: string[];
}

const LIMIT = 50;

/**
 * Undo stores the document by reference. Frame blobs are immutable, so a
 * snapshot does not copy pixels. Annotations are cloned because gestures
 * edit them in place.
 */
export class History {
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private current: Snapshot;

  constructor(initial: Snapshot) {
    this.current = cloneSnapshot(initial);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  commit(next: Snapshot): void {
    this.undoStack.push(this.current);
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.current = cloneSnapshot(next);
  }

  undo(): Snapshot | null {
    const previous = this.undoStack.pop();
    if (!previous) return null;
    this.redoStack.push(this.current);
    this.current = previous;
    return cloneSnapshot(this.current);
  }

  redo(): Snapshot | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(this.current);
    this.current = next;
    return cloneSnapshot(this.current);
  }

  reset(next: Snapshot): void {
    this.undoStack = [];
    this.redoStack = [];
    this.current = cloneSnapshot(next);
  }

  peek(): Snapshot {
    return cloneSnapshot(this.current);
  }
}

function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return {
    doc: snapshot.doc,
    annotations: structuredClone(snapshot.annotations),
    selectedIds: [...snapshot.selectedIds],
  };
}
