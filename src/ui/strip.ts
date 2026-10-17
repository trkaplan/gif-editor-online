import type { Frame } from '../types';

const STEP = 112;
const THUMB = 104;

export interface StripClick {
  index: number;
  shift: boolean;
  meta: boolean;
}

export interface StripMove {
  dragIndex: number;
  beforeIndex: number;
}

export interface StripMenu {
  index: number;
  x: number;
  y: number;
}

interface ThumbUrl {
  blob: Blob;
  url: string;
}

/**
 * Virtualized horizontal filmstrip. A drag that starts on a thumbnail reports
 * the drop slot; the editor decides whether the whole selection moves.
 */
export class FrameStrip {
  private frames: Frame[] = [];
  private selected = new Set<string>();
  private activeIndex = 0;
  private urls = new Map<string, ThumbUrl>();
  private pool: HTMLButtonElement[] = [];
  private spacer: HTMLDivElement;
  private marker: HTMLDivElement;
  private drag: { index: number; startX: number; startY: number; pointerId: number; dragging: boolean } | null = null;
  private beforeIndex = 0;

  constructor(
    private viewport: HTMLElement,
    private onClick: (event: StripClick) => void,
    private onMove: (event: StripMove) => void,
    private onMenu: (event: StripMenu) => void,
  ) {
    this.spacer = document.createElement('div');
    this.spacer.className = 'strip-spacer';
    this.marker = document.createElement('div');
    this.marker.className = 'strip-marker';
    this.marker.hidden = true;
    this.spacer.append(this.marker);
    this.viewport.append(this.spacer);
    this.viewport.addEventListener('pointerdown', this.onPointerDown);
    this.viewport.addEventListener('contextmenu', this.onContextMenu);
    this.viewport.addEventListener('pointermove', this.onPointerMove);
    this.viewport.addEventListener('pointerup', this.onPointerUp);
    this.viewport.addEventListener('pointercancel', this.onPointerUp);
    this.viewport.addEventListener('scroll', () => this.layout(), { passive: true });
    this.viewport.addEventListener(
      'wheel',
      (event) => {
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        this.viewport.scrollLeft += event.deltaY;
        event.preventDefault();
      },
      { passive: false },
    );
  }

  setState(frames: Frame[], selected: readonly string[], activeIndex: number): void {
    this.frames = frames;
    this.selected = new Set(selected);
    this.activeIndex = activeIndex;
    this.forgetStale();
    this.layout();
  }

  reveal(index: number): void {
    if (index < 0 || index >= this.frames.length) return;
    const left = index * STEP;
    const right = left + STEP;
    const viewLeft = this.viewport.scrollLeft;
    const viewRight = viewLeft + this.viewport.clientWidth;
    if (left < viewLeft) this.viewport.scrollLeft = left;
    else if (right > viewRight) this.viewport.scrollLeft = right - this.viewport.clientWidth;
    this.layout();
  }

  private forgetStale(): void {
    const live = new Set(this.frames.map((frame) => frame.id));
    for (const [id, entry] of this.urls) {
      const frame = this.frames.find((item) => item.id === id);
      if (!live.has(id) || (frame && frame.thumb !== entry.blob)) {
        URL.revokeObjectURL(entry.url);
        this.urls.delete(id);
      }
    }
  }

  private urlFor(frame: Frame): string {
    const cached = this.urls.get(frame.id);
    if (cached && cached.blob === frame.thumb) return cached.url;
    if (cached) URL.revokeObjectURL(cached.url);
    const url = URL.createObjectURL(frame.thumb);
    this.urls.set(frame.id, { blob: frame.thumb, url });
    return url;
  }

  private layout(): void {
    const count = this.frames.length;
    this.spacer.style.width = `${count * STEP}px`;
    const scroll = this.viewport.scrollLeft;
    const width = this.viewport.clientWidth || 1;
    const start = Math.max(0, Math.floor(scroll / STEP) - 2);
    const end = Math.min(count, Math.ceil((scroll + width) / STEP) + 2);
    const needed = Math.max(0, end - start);
    while (this.pool.length < needed) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'thumb';
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      const meta = document.createElement('span');
      button.append(img, meta);
      this.spacer.append(button);
      this.pool.push(button);
    }
    for (let i = 0; i < this.pool.length; i++) {
      const button = this.pool[i];
      if (i >= needed) {
        button.hidden = true;
        continue;
      }
      const index = start + i;
      const frame = this.frames[index];
      button.hidden = false;
      button.dataset.index = String(index);
      button.style.transform = `translateX(${index * STEP}px)`;
      button.classList.toggle('selected', this.selected.has(frame.id));
      button.classList.toggle('active', index === this.activeIndex);
      button.style.width = `${THUMB}px`;
      const img = button.querySelector('img');
      const meta = button.querySelector('span');
      if (img) {
        const url = this.urlFor(frame);
        if (img.getAttribute('src') !== url) img.src = url;
      }
      if (meta) meta.textContent = `${index + 1} - ${frame.delayMs} ms`;
    }
  }

  private onContextMenu = (event: MouseEvent): void => {
    const thumb = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-index]');
    if (!thumb) return;
    event.preventDefault();
    const index = Number(thumb.dataset.index);
    if (!Number.isInteger(index)) return;
    this.onMenu({ index, x: event.clientX, y: event.clientY });
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const thumb = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-index]');
    if (!thumb) return;
    const index = Number(thumb.dataset.index);
    if (!Number.isInteger(index)) return;
    this.drag = { index, startX: event.clientX, startY: event.clientY, pointerId: event.pointerId, dragging: false };
    try {
      this.viewport.setPointerCapture(event.pointerId);
    } catch {
      /* The pointer can already be inactive. */
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    const distance = Math.hypot(event.clientX - this.drag.startX, event.clientY - this.drag.startY);
    if (!this.drag.dragging && distance < 4) return;
    this.drag.dragging = true;
    const rect = this.spacer.getBoundingClientRect();
    const x = event.clientX - rect.left;
    this.beforeIndex = Math.max(0, Math.min(this.frames.length, Math.round(x / STEP)));
    this.marker.hidden = false;
    this.marker.style.transform = `translateX(${this.beforeIndex * STEP}px)`;
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    const drag = this.drag;
    this.drag = null;
    this.marker.hidden = true;
    try {
      if (this.viewport.hasPointerCapture(event.pointerId)) this.viewport.releasePointerCapture(event.pointerId);
    } catch {
      /* The pointer can already be inactive. */
    }
    if (drag.dragging) this.onMove({ dragIndex: drag.index, beforeIndex: this.beforeIndex });
    else this.onClick({ index: drag.index, shift: event.shiftKey, meta: event.metaKey || event.ctrlKey });
  };
}
