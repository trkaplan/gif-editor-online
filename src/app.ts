import { GifClient } from './gif/client';
import type { DecodeFrame, DecodeStartInfo } from './gif/client';
import {
  annotationsOnFrame,
  assignAnnotationFrames,
  cloneAnnotationsForDuplicates,
  cropAnnotations,
  dropFrameIds,
  sameFrameIds,
  scaleAnnotations,
} from './model/annotations';
import {
  deleteFrames,
  duplicateFrames,
  insertSlot,
  moveFrames,
  rangeIds,
  reverseFrames,
  selectionAfterDelete,
  setDelay,
} from './model/edits';
import { History } from './model/history';
import type { Snapshot } from './model/history';
import { drawAnnotations, drawCropOverlay, drawHandles } from './render/annotate';
import { fontCss, hitTest, isDrawable, resizeAnnotation, setTextMeasurer, textWidth, translateAnnotation } from './render/hit';
import { clearSession, loadSession, saveSession } from './storage/db';
import type { Annotation, Doc, Frame, Rect, RectAnn, TextAnn, Tool } from './types';
import { BLUR_RADIUS } from './types';
import { BitmapCache } from './ui/bitmap-cache';
import { FrameStrip } from './ui/strip';
import type { StripMenu } from './ui/strip';
import { clamp, createId, downloadBlob, formatBytes, normalizeRect, sameFrameOrder } from './util';

const MAX_EDGE = 8192;

type Gesture =
  | { kind: 'new'; id: string; before: Annotation[]; pointerId: number }
  | { kind: 'move'; id: string; start: Annotation; x: number; y: number; before: Annotation[]; pointerId: number; dirty: boolean }
  | { kind: 'resize'; id: string; handle: string; start: Annotation; before: Annotation[]; pointerId: number; dirty: boolean }
  | { kind: 'crop-new'; x: number; y: number; before: Rect | null; pointerId: number }
  | { kind: 'crop-move'; start: Rect; x: number; y: number; pointerId: number }
  | { kind: 'crop-resize'; handle: string; start: Rect; pointerId: number };

const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: 'select', label: 'Select', key: 'V' },
  { tool: 'arrow', label: 'Arrow', key: 'A' },
  { tool: 'rect', label: 'Rect', key: 'R' },
  { tool: 'pen', label: 'Pen', key: 'P' },
  { tool: 'text', label: 'Text', key: 'T' },
  { tool: 'highlight', label: 'Highlight', key: 'H' },
  { tool: 'blur', label: 'Blur', key: 'B' },
];

const SHORTCUTS: [string, string][] = [
  ['Undo', '⌘Z'],
  ['Redo', '⇧⌘Z'],
  ['Play / pause', 'Space'],
  ['Previous / next frame', 'Left / Right'],
  ['Extend selection', 'Shift+Left / Shift+Right'],
  ['First / last frame', 'Home / End'],
  ['Select all', '⌘A'],
  ['Toggle frame', '⌘Click'],
  ['Select range', 'Shift+Click'],
  ['Delete', 'Delete'],
  ['Duplicate', '⌘D'],
  ['Nudge delay', '[ ]'],
  ['Apply drawings', '⌘Enter'],
  ['Frame menu', 'Right-click'],
  ['Export GIF', '⌘E'],
  ['Export PNG', '⇧⌘E'],
  ['Open', '⌘O'],
  ['Help', '?'],
  ['Close or cancel', 'Esc'],
  ['Select', 'V'],
  ['Arrow', 'A'],
  ['Rectangle', 'R'],
  ['Pen', 'P'],
  ['Text', 'T'],
  ['Highlight', 'H'],
  ['Blur', 'B'],
  ['Crop', 'C'],
];

export class Editor {
  private doc: Doc | null = null;
  private annotations: Annotation[] = [];
  private selectedIds: string[] = [];
  private anchorIndex = 0;
  private focusIndex = 0;
  private tool: Tool = 'select';
  private color = '#ef4444';
  private strokeWidth = 4;
  private fontSize = 32;
  private textBackground = false;
  private selectedAnnId: string | null = null;
  private editingTextId: string | null = null;
  private textBefore = '';
  private textDirty = false;
  private ignoreTextBlur = false;
  private crop: Rect | null = null;
  private playing = false;
  private playIndex = 0;
  private raf = 0;
  private playAcc = 0;
  private playLast = 0;
  private busy = false;
  private holdSave = false;
  private autosaveOk = true;
  private saveTimer = 0;
  private saveChain: Promise<void> = Promise.resolve();
  private saveToken = 0;
  private revision = 0;
  private exportCache: { key: string; bytes: Uint8Array } | null = null;
  private estimateToken = 0;
  private exporting = false;
  private viewScale = 1;
  private paintToken = 0;
  private confirmMode: 'new' | 'open' | null = null;
  private pendingFile: File | null = null;
  private gesture: Gesture | null = null;
  private dragDepth = 0;
  private resizeRatio = 1;
  private syncingSize = false;
  private history = new History({ doc: null, annotations: [], selectedIds: [] });
  private client = new GifClient();
  private cache = new BitmapCache();
  private strip: FrameStrip;
  private ctx: CanvasRenderingContext2D;

  private root: HTMLElement;
  private openButton!: HTMLButtonElement;
  private newButton!: HTMLButtonElement;
  private undoButton!: HTMLButtonElement;
  private redoButton!: HTMLButtonElement;
  private deleteButton!: HTMLButtonElement;
  private duplicateButton!: HTMLButtonElement;
  private reverseButton!: HTMLButtonElement;
  private delayInput!: HTMLInputElement;
  private playButton!: HTMLButtonElement;
  private loopInput!: HTMLInputElement;
  private toolButtons: HTMLButtonElement[] = [];
  private colorInput!: HTMLInputElement;
  private strokeInput!: HTMLInputElement;
  private fontInput!: HTMLInputElement;
  private textBoxInput!: HTMLInputElement;
  private applyButton!: HTMLButtonElement;
  private cropButton!: HTMLButtonElement;
  private resizeButton!: HTMLButtonElement;
  private pngButton!: HTMLButtonElement;
  private exportButton!: HTMLButtonElement;
  private helpButton!: HTMLButtonElement;
  private fileInput!: HTMLInputElement;
  private confirmBar!: HTMLDivElement;
  private confirmText!: HTMLSpanElement;
  private confirmOk!: HTMLButtonElement;
  private cropBar!: HTMLDivElement;
  private resizeBar!: HTMLDivElement;
  private resizeWidth!: HTMLInputElement;
  private resizeHeight!: HTMLInputElement;
  private resizeLock!: HTMLInputElement;
  private stage!: HTMLDivElement;
  private empty!: HTMLParagraphElement;
  private wrap!: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private textArea!: HTMLTextAreaElement;
  private stripView!: HTMLDivElement;
  private statusText!: HTMLParagraphElement;
  private saveText!: HTMLParagraphElement;
  private helpOverlay!: HTMLDivElement;
  private exportModal!: HTMLDivElement;
  private colorsInput!: HTMLInputElement;
  private colorsValue!: HTMLSpanElement;
  private ditherInput!: HTMLSelectElement;
  private scaleInput!: HTMLSelectElement;
  private exportSize!: HTMLParagraphElement;
  private exportHint!: HTMLParagraphElement;
  private exportDownload!: HTMLButtonElement;
  private frameMenu!: HTMLDivElement;
  private frameMenuReverse!: HTMLButtonElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.className = 'app';
    this.canvas = document.createElement('canvas');
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas is not available.');
    this.ctx = ctx;
    this.build();
    this.strip = new FrameStrip(
      this.stripView,
      (event) => this.onStripClick(event),
      (event) => this.onStripMove(event),
      (event) => this.showFrameMenu(event),
    );
    this.bind();
    this.installMeasurer();
    this.renderChrome();
  }

  async start(): Promise<void> {
    try {
      const saved = await loadSession();
      if (saved) {
        this.doc = saved.doc;
        this.annotations = saved.annotations;
        this.selectedIds = saved.selectedIds.filter((id) => saved.doc.frames.some((frame) => frame.id === id));
        if (this.selectedIds.length === 0 && saved.doc.frames[0]) this.selectedIds = [saved.doc.frames[0].id];
        this.syncIndexesFromSelection();
        this.history.reset({ doc: this.doc, annotations: this.annotations, selectedIds: [...this.selectedIds] });
        this.setStatus('Restored your last session.');
        this.saveText.textContent = 'Saved';
      }
    } catch {
      this.autosaveOk = false;
      this.setStatus('Autosave is unavailable in this browser.');
      this.saveText.textContent = 'Autosave is unavailable in this browser.';
    }
    this.fitPreview();
    this.syncStrip();
    this.renderChrome();
    void this.paint();
  }

  async openBuffer(buffer: ArrayBuffer, name = 'animation.gif'): Promise<void> {
    if (this.busy) return;
    this.stopPlayback(false);
    this.closeTextEditor(false);
    const previous = this.history.peek();
    this.busy = true;
    this.holdSave = true;
    window.clearTimeout(this.saveTimer);
    this.client.cancelEncode();
    this.renderChrome();
    const frames: Frame[] = [];
    let failed = false;
    try {
      let next: Doc = { width: 1, height: 1, repeat: 0, name, frames };
      let total = 0;
      await this.client.decode(buffer, {
        onStart: (info: DecodeStartInfo) => {
          total = info.total;
          next = { width: info.width, height: info.height, repeat: info.repeat, name, frames };
          this.doc = next;
          this.annotations = [];
          this.selectedIds = [];
          this.selectedAnnId = null;
          this.crop = null;
          this.tool = this.tool === 'crop' ? 'select' : this.tool;
          this.setStatus(`Decoding 0 / ${info.total}`);
          this.fitPreview();
          this.syncStrip();
          this.renderChrome();
        },
        onFrame: (message: DecodeFrame) => {
          const frame: Frame = {
            id: createId(),
            delayMs: message.delayMs,
            pixels: new Blob([message.pixels]),
            thumb: new Blob([message.thumb], { type: 'image/png' }),
          };
          frames[message.index] = frame;
          if (message.index === 0) {
            this.selectedIds = [frame.id];
            this.focusIndex = 0;
            this.anchorIndex = 0;
            void this.paint();
          }
          this.setStatus(`Decoding ${message.index + 1} / ${message.total}`);
          this.syncStrip();
        },
      });
      if (frames.length !== total || frames.some((frame) => !frame)) throw new Error('Could not read this GIF.');
      this.doc = next;
      this.annotations = [];
      this.selectedIds = [frames[0].id];
      this.focusIndex = 0;
      this.anchorIndex = 0;
      this.selectedAnnId = null;
      this.crop = null;
      this.cache.clear();
      this.holdSave = false;
      this.commit();
      this.setStatus(this.frameStatus());
    } catch (error) {
      failed = true;
      this.restore(previous);
      const message = error instanceof Error ? error.message : '';
      this.setStatus(message === 'Cancelled' ? this.frameStatus() : message.startsWith('This GIF') ? message : 'Could not read this GIF.');
    } finally {
      this.holdSave = false;
      this.busy = false;
      if (failed) this.scheduleSave();
      this.fitPreview();
      this.syncStrip();
      this.renderChrome();
      void this.paint();
    }
  }

  private build(): void {
    const toolbar = el('div', 'toolbar');
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'image/gif,.gif';
    this.fileInput.className = 'file-input';
    this.fileInput.tabIndex = -1;
    this.openButton = button('Open', 'Cmd/Ctrl+O', () => this.fileInput.click());
    this.newButton = button('New', 'Discard the current GIF', () => this.askDiscard());
    toolbar.append(group(this.openButton, this.newButton, this.fileInput));

    this.undoButton = button('Undo', 'Cmd/Ctrl+Z', () => this.undo());
    this.redoButton = button('Redo', 'Shift+Cmd/Ctrl+Z', () => this.redo());
    toolbar.append(group(this.undoButton, this.redoButton));

    this.deleteButton = button('Delete', 'Delete', () => this.deleteSelectedFrames());
    this.duplicateButton = button('Duplicate', 'Cmd/Ctrl+D', () => this.duplicateSelection());
    this.reverseButton = button('Reverse', 'Reverse the selection', () => this.reverseSelection());
    toolbar.append(group(this.deleteButton, this.duplicateButton, this.reverseButton));

    this.delayInput = document.createElement('input');
    this.delayInput.type = 'number';
    this.delayInput.min = '0';
    this.delayInput.max = '60000';
    this.delayInput.step = '1';
    this.delayInput.ariaLabel = 'Delay';
    const delayLabel = el('label', 'field');
    delayLabel.append('Delay ', this.delayInput, ' ms');
    this.playButton = button('Play', 'Space', () => this.togglePlay());
    this.loopInput = document.createElement('input');
    this.loopInput.type = 'checkbox';
    this.loopInput.checked = true;
    const loopLabel = el('label', 'field');
    loopLabel.append(this.loopInput, ' Loop');
    toolbar.append(group(delayLabel, this.playButton, loopLabel));

    for (const item of TOOLS) {
      const toolButton = button(item.label, item.key, () => this.setTool(item.tool));
      toolButton.dataset.tool = item.tool;
      this.toolButtons.push(toolButton);
    }
    toolbar.append(group(...this.toolButtons));

    this.colorInput = document.createElement('input');
    this.colorInput.type = 'color';
    this.colorInput.value = this.color;
    this.colorInput.title = 'Color';
    this.colorInput.ariaLabel = 'Color';
    this.strokeInput = numInput(1, 64, this.strokeWidth, 'Stroke');
    this.fontInput = numInput(8, 512, this.fontSize, 'Font size');
    this.textBoxInput = document.createElement('input');
    this.textBoxInput.type = 'checkbox';
    const textBoxLabel = el('label', 'field');
    textBoxLabel.append(this.textBoxInput, ' Text box');
    const strokeLabel = el('label', 'field');
    strokeLabel.append('Stroke ', this.strokeInput);
    const fontLabel = el('label', 'field');
    fontLabel.append('Font size ', this.fontInput);
    toolbar.append(group(this.colorInput, strokeLabel, fontLabel, textBoxLabel));

    this.applyButton = button('Apply', 'Place on the selected frames. You can keep editing until export.', () => this.applyDrawings());
    toolbar.append(group(this.applyButton));

    this.cropButton = button('Crop', 'C', () => this.setTool('crop'));
    this.resizeButton = button('Resize', 'Resize the animation', () => this.openResize());
    this.pngButton = button('PNG', 'Shift+Cmd/Ctrl+E', () => void this.exportPng());
    this.exportButton = button('Export', 'Cmd/Ctrl+E', () => this.openExport());
    this.helpButton = button('Help', '?', () => this.toggleHelp());
    toolbar.append(group(this.cropButton, this.resizeButton, this.pngButton, this.exportButton, this.helpButton));

    this.confirmBar = el('div', 'confirm');
    this.confirmBar.hidden = true;
    this.confirmText = document.createElement('span');
    this.confirmOk = button('Discard', '', () => this.acceptConfirm());
    const confirmCancel = button('Cancel', 'Esc', () => this.hideConfirm());
    this.confirmBar.append(this.confirmText, this.confirmOk, confirmCancel);

    this.cropBar = el('div', 'subbar');
    this.cropBar.hidden = true;
    this.cropBar.append(
      document.createTextNode('Crop'),
      button('Apply crop', 'Crop every frame', () => void this.applyCrop()),
      button('Cancel', 'Esc', () => this.setTool('select')),
    );

    this.resizeBar = el('div', 'subbar');
    this.resizeBar.hidden = true;
    this.resizeWidth = numInput(1, MAX_EDGE, 1, 'Width');
    this.resizeHeight = numInput(1, MAX_EDGE, 1, 'Height');
    this.resizeLock = document.createElement('input');
    this.resizeLock.type = 'checkbox';
    this.resizeLock.checked = true;
    const widthLabel = el('label', 'field');
    widthLabel.append('Width ', this.resizeWidth);
    const heightLabel = el('label', 'field');
    heightLabel.append('Height ', this.resizeHeight);
    const lockLabel = el('label', 'field');
    lockLabel.append(this.resizeLock, ' Lock aspect');
    this.resizeBar.append(
      widthLabel,
      heightLabel,
      lockLabel,
      button('Apply', 'Resize every frame', () => void this.applyResize()),
      button('Cancel', 'Esc', () => {
        this.resizeBar.hidden = true;
      }),
    );

    this.stage = el('div', 'stage');
    this.empty = el('p', 'empty');
    this.empty.textContent = 'Drop a GIF here, or click Open.';
    this.wrap = el('div', 'canvas-wrap');
    this.textArea = document.createElement('textarea');
    this.textArea.hidden = true;
    this.textArea.spellcheck = false;
    this.textArea.rows = 1;
    this.wrap.append(this.canvas, this.textArea);
    this.stage.append(this.wrap, this.empty);

    this.stripView = el('div', 'strip');
    const status = el('div', 'status');
    this.statusText = document.createElement('p');
    this.statusText.setAttribute('aria-live', 'polite');
    this.saveText = document.createElement('p');
    status.append(this.statusText, this.saveText);

    this.helpOverlay = this.buildHelp();
    this.exportModal = this.buildExport();
    this.frameMenu = this.buildFrameMenu();
    this.root.append(toolbar, this.confirmBar, this.cropBar, this.resizeBar, this.stage, this.stripView, status, this.helpOverlay, this.exportModal, this.frameMenu);
  }

  private buildFrameMenu(): HTMLDivElement {
    const menu = el('div', 'menu');
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    const duplicate = menuItem('Duplicate', '⌘D', () => {
      this.hideFrameMenu();
      this.duplicateSelection();
    });
    this.frameMenuReverse = menuItem('Reverse', '', () => {
      this.hideFrameMenu();
      this.reverseSelection();
    });
    const delay = menuItem('Set delay', '', () => {
      this.hideFrameMenu();
      this.delayInput.focus();
      this.delayInput.select();
    });
    const remove = menuItem('Delete', 'Delete', () => {
      this.hideFrameMenu();
      this.deleteSelectedFrames();
    });
    remove.classList.add('danger');
    menu.append(duplicate, this.frameMenuReverse, delay, remove);
    return menu;
  }

  private buildHelp(): HTMLDivElement {
    const overlay = el('div', 'overlay');
    overlay.hidden = true;
    const dialog = el('div', 'dialog');
    const title = document.createElement('h2');
    title.textContent = 'Shortcuts';
    const list = document.createElement('dl');
    list.className = 'shortcuts';
    for (const [name, keys] of SHORTCUTS) {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = name;
      const dd = document.createElement('dd');
      dd.textContent = keys;
      row.append(dt, dd);
      list.append(row);
    }
    const close = button('Close', 'Esc', () => {
      overlay.hidden = true;
    });
    const actions = el('div', 'dialog-actions');
    actions.append(close);
    dialog.append(title, list, actions);
    overlay.append(dialog);
    overlay.addEventListener('click', () => {
      overlay.hidden = true;
    });
    dialog.addEventListener('click', (event) => event.stopPropagation());
    return overlay;
  }

  private buildExport(): HTMLDivElement {
    const overlay = el('div', 'overlay');
    overlay.hidden = true;
    const dialog = el('div', 'dialog');
    const title = document.createElement('h2');
    title.textContent = 'Export GIF';
    this.colorsInput = document.createElement('input');
    this.colorsInput.type = 'range';
    this.colorsInput.min = '2';
    this.colorsInput.max = '256';
    this.colorsInput.value = '256';
    this.colorsValue = document.createElement('span');
    this.colorsValue.textContent = '256';
    const colorsLabel = el('label', 'field');
    colorsLabel.append('Colors ', this.colorsInput, this.colorsValue);
    this.ditherInput = document.createElement('select');
    this.ditherInput.append(option('none', 'None'), option('floyd', 'Floyd-Steinberg'));
    this.ditherInput.value = 'none';
    const ditherLabel = el('label', 'field');
    ditherLabel.append('Dither ', this.ditherInput);
    this.scaleInput = document.createElement('select');
    this.scaleInput.append(option('1', '100%'), option('0.75', '75%'), option('0.5', '50%'), option('0.25', '25%'));
    const scaleLabel = el('label', 'field');
    scaleLabel.append('Scale ', this.scaleInput);
    this.exportSize = document.createElement('p');
    this.exportSize.textContent = 'Estimating...';
    this.exportHint = document.createElement('p');
    this.exportHint.hidden = true;
    this.exportDownload = button('Download', 'Download the GIF', () => void this.downloadExport());
    this.exportDownload.classList.add('primary');
    const cancel = button('Cancel', 'Esc', () => this.closeExport());
    const actions = el('div', 'dialog-actions');
    actions.append(cancel, this.exportDownload);
    dialog.append(title, colorsLabel, ditherLabel, scaleLabel, this.exportSize, this.exportHint, actions);
    overlay.append(dialog);
    overlay.addEventListener('click', () => this.closeExport());
    dialog.addEventListener('click', (event) => event.stopPropagation());
    return overlay;
  }

  private bind(): void {
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (file) this.requestOpen(file);
    });
    this.delayInput.addEventListener('change', () => this.commitDelayFromInput());
    this.delayInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.commitDelayFromInput();
      this.delayInput.blur();
    });
    this.loopInput.addEventListener('change', () => {
      if (!this.doc || this.busy) return;
      this.doc = { ...this.doc, repeat: this.loopInput.checked ? 0 : -1 };
      this.commit();
    });
    this.colorInput.addEventListener('input', () => this.onColor(this.colorInput.value));
    this.strokeInput.addEventListener('change', () => this.onStroke(Number(this.strokeInput.value)));
    this.fontInput.addEventListener('change', () => this.onFontSize(Number(this.fontInput.value)));
    this.textBoxInput.addEventListener('change', () => this.onTextBox(this.textBoxInput.checked));
    this.resizeWidth.addEventListener('input', () => this.onResizeInput('w'));
    this.resizeHeight.addEventListener('input', () => this.onResizeInput('h'));
    this.resizeLock.addEventListener('change', () => {
      if (!this.resizeLock.checked) return;
      const width = Number(this.resizeWidth.value) || 1;
      const height = Number(this.resizeHeight.value) || 1;
      this.resizeRatio = width / height;
    });
    this.colorsInput.addEventListener('input', () => {
      this.colorsValue.textContent = this.colorsInput.value;
      this.scheduleEstimate();
    });
    this.ditherInput.addEventListener('change', () => this.scheduleEstimate());
    this.scaleInput.addEventListener('change', () => this.scheduleEstimate());
    this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.canvas.addEventListener('pointercancel', (event) => this.onPointerCancel(event));
    this.canvas.addEventListener('dblclick', (event) => this.onDoubleClick(event));
    this.textArea.addEventListener('input', () => this.onTextInput());
    this.textArea.addEventListener('blur', () => this.onTextBlur());
    this.textArea.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' || event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this.textArea.blur();
      }
    });
    window.addEventListener('keydown', (event) => this.onKeyDown(event));
    window.addEventListener('pointerdown', (event) => {
      if (this.frameMenu.hidden) return;
      if (event.target instanceof Node && this.frameMenu.contains(event.target)) return;
      this.hideFrameMenu();
    });
    this.stripView.addEventListener('scroll', () => this.hideFrameMenu(), { passive: true });
    window.addEventListener('dragenter', (event) => this.onDragEnter(event));
    window.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    });
    window.addEventListener('dragleave', () => this.onDragLeave());
    window.addEventListener('dragend', () => this.onDragLeave(true));
    window.addEventListener('drop', (event) => {
      event.preventDefault();
      this.onDragLeave(true);
      const file = [...(event.dataTransfer?.files ?? [])].find((item) => isGifFile(item));
      if (!file) {
        this.setStatus('Choose a GIF file.');
        return;
      }
      this.requestOpen(file);
    });
    window.addEventListener('beforeunload', () => this.flushSave());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushSave();
    });
    new ResizeObserver(() => {
      this.fitPreview();
      void this.paint();
    }).observe(this.stage);
  }

  private installMeasurer(): void {
    const measure = document.createElement('canvas').getContext('2d');
    if (!measure) return;
    setTextMeasurer((text, fontSize) => {
      measure.font = fontCss(fontSize);
      return Math.max(8, measure.measureText(text || ' ').width);
    });
  }

  private onDragEnter(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    this.dragDepth += 1;
    this.stage.classList.add('dragover');
  }

  private onDragLeave(reset = false): void {
    this.dragDepth = reset ? 0 : Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.stage.classList.remove('dragover');
  }

  private requestOpen(file: File): void {
    if (this.busy) return;
    if (!isGifFile(file)) {
      this.setStatus('Choose a GIF file.');
      return;
    }
    if (this.doc) {
      this.pendingFile = file;
      this.showConfirm('open', 'Replace the current GIF?', 'Replace');
      return;
    }
    void this.loadFile(file);
  }

  private async loadFile(file: File): Promise<void> {
    if (!isGifFile(file)) {
      this.setStatus('Choose a GIF file.');
      return;
    }
    const buffer = await file.arrayBuffer();
    await this.openBuffer(buffer, file.name);
  }

  private askDiscard(): void {
    if (!this.doc || this.busy) return;
    this.showConfirm('new', 'Discard the current GIF?', 'Discard');
  }

  private showConfirm(mode: 'new' | 'open', message: string, ok: string): void {
    this.confirmMode = mode;
    this.confirmText.textContent = message;
    this.confirmOk.textContent = ok;
    this.confirmBar.hidden = false;
  }

  private hideConfirm(): void {
    this.confirmMode = null;
    this.pendingFile = null;
    this.confirmBar.hidden = true;
  }

  private acceptConfirm(): void {
    const mode = this.confirmMode;
    const file = this.pendingFile;
    this.hideConfirm();
    if (mode === 'new') this.discard();
    else if (mode === 'open' && file) void this.loadFile(file);
  }

  private discard(): void {
    this.stopPlayback(false);
    this.closeTextEditor(false);
    this.cache.clear();
    this.doc = null;
    this.annotations = [];
    this.selectedIds = [];
    this.selectedAnnId = null;
    this.crop = null;
    this.tool = 'select';
    this.resizeBar.hidden = true;
    this.commit();
    void clearSession().catch(() => undefined);
    this.setStatus('');
    this.fitPreview();
    this.syncStrip();
    this.renderChrome();
    void this.paint();
  }

  private restore(snapshot: Snapshot): void {
    this.doc = snapshot.doc;
    this.annotations = snapshot.annotations;
    this.selectedIds = snapshot.selectedIds.filter((id) => snapshot.doc?.frames.some((frame) => frame.id === id) ?? false);
    if (this.doc && this.selectedIds.length === 0 && this.doc.frames[0]) this.selectedIds = [this.doc.frames[0].id];
    this.syncIndexesFromSelection();
    this.selectedAnnId = null;
    this.crop = null;
    this.cache.clear();
    this.closeTextEditor(false);
  }

  private commit(): void {
    this.revision += 1;
    this.exportCache = null;
    this.history.commit({
      doc: this.doc,
      annotations: this.annotations,
      selectedIds: [...this.selectedIds],
    });
    if (!this.holdSave) this.scheduleSave();
    this.renderChrome();
    if (!this.exportModal.hidden) this.scheduleEstimate();
  }

  private undo(): void {
    if (this.busy) return;
    const snapshot = this.history.undo();
    if (snapshot) this.applySnapshot(snapshot);
  }

  private redo(): void {
    if (this.busy) return;
    const snapshot = this.history.redo();
    if (snapshot) this.applySnapshot(snapshot);
  }

  private applySnapshot(snapshot: Snapshot): void {
    this.stopPlayback(false);
    this.closeTextEditor(false);
    this.crop = null;
    if (this.tool === 'crop') this.tool = 'select';
    this.resizeBar.hidden = true;
    this.doc = snapshot.doc;
    this.annotations = snapshot.annotations;
    this.selectedIds = snapshot.selectedIds.filter((id) => snapshot.doc?.frames.some((frame) => frame.id === id) ?? false);
    if (this.doc && this.selectedIds.length === 0 && this.doc.frames[0]) this.selectedIds = [this.doc.frames[0].id];
    this.selectedAnnId = null;
    this.cache.clear();
    this.syncIndexesFromSelection();
    this.revision += 1;
    this.exportCache = null;
    this.scheduleSave();
    this.fitPreview();
    this.syncStrip();
    this.renderChrome();
    this.setStatus(this.frameStatus());
    void this.paint();
    if (!this.exportModal.hidden) this.scheduleEstimate();
  }

  private scheduleSave(): void {
    if (!this.autosaveOk || this.holdSave) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.enqueueSave(), 400);
  }

  private flushSave(): void {
    window.clearTimeout(this.saveTimer);
    this.enqueueSave();
  }

  private enqueueSave(): void {
    if (!this.autosaveOk || this.holdSave) return;
    const token = ++this.saveToken;
    this.saveText.textContent = 'Saving...';
    this.saveChain = this.saveChain.then(() => this.persist(token)).catch(() => this.persist(token));
  }

  private async persist(token: number): Promise<void> {
    if (this.holdSave) return;
    const doc = this.doc;
    const annotations = structuredClone(this.annotations);
    const selectedIds = [...this.selectedIds];
    try {
      if (!doc) await clearSession();
      else await saveSession(doc, annotations, selectedIds);
      if (token === this.saveToken) this.saveText.textContent = 'Saved';
    } catch {
      this.autosaveOk = false;
      if (token === this.saveToken) {
        this.saveText.textContent = 'Autosave is unavailable in this browser.';
        this.setStatus('Autosave is unavailable in this browser.');
      }
    }
  }

  private onStripClick(event: { index: number; shift: boolean; meta: boolean }): void {
    if (!this.doc || this.busy) return;
    this.stopPlayback(false);
    const frames = this.doc.frames;
    const index = clamp(event.index, 0, frames.length - 1);
    if (event.shift) {
      this.focusIndex = index;
      this.selectedIds = rangeIds(frames, this.anchorIndex, index);
    } else if (event.meta) {
      const id = frames[index].id;
      if (this.selectedIds.includes(id)) {
        if (this.selectedIds.length === 1) return;
        this.selectedIds = this.selectedIds.filter((item) => item !== id);
      } else {
        this.selectedIds = [...this.selectedIds, id];
      }
      this.focusIndex = index;
      this.anchorIndex = index;
    } else {
      this.anchorIndex = index;
      this.focusIndex = index;
      this.selectedIds = [frames[index].id];
    }
    this.afterSelectionChange();
  }

  private onStripMove(event: { dragIndex: number; beforeIndex: number }): void {
    if (!this.doc || this.busy) return;
    this.stopPlayback(false);
    const frames = this.doc.frames;
    const drag = frames[event.dragIndex];
    if (!drag) return;
    let ids = this.selectedIds;
    if (!ids.includes(drag.id)) {
      ids = [drag.id];
      this.selectedIds = ids;
      this.anchorIndex = event.dragIndex;
      this.focusIndex = event.dragIndex;
    }
    const slot = insertSlot(frames, new Set(ids), event.beforeIndex);
    const next = moveFrames(this.doc, ids, slot);
    if (sameFrameOrder(frames, next.frames)) {
      this.afterSelectionChange();
      return;
    }
    this.doc = next;
    this.syncIndexesFromSelection();
    this.commit();
    this.syncStrip();
    this.strip.reveal(this.focusIndex);
    this.setStatus(this.frameStatus());
  }

  private afterSelectionChange(): void {
    this.syncStrip();
    this.strip.reveal(this.focusIndex);
    this.renderChrome();
    this.setStatus(this.frameStatus());
    void this.paint();
    if (!this.exportModal.hidden) this.scheduleEstimate();
  }

  private deleteSelectedFrames(): void {
    if (!this.doc || this.busy || this.selectedIds.length === 0) return;
    this.stopPlayback(false);
    const current = this.doc.frames;
    const nextIds = selectionAfterDelete(current, this.selectedIds);
    const removed = new Set(this.selectedIds);
    const next = deleteFrames(this.doc, this.selectedIds);
    for (const id of removed) this.cache.invalidate(id);
    if (next.frames.length === 0) {
      this.cache.clear();
      this.doc = null;
      this.annotations = [];
      this.selectedIds = [];
      this.selectedAnnId = null;
      this.crop = null;
    } else {
      this.doc = next;
      this.annotations = dropFrameIds(this.annotations, removed);
      if (this.selectedAnnId && !this.annotations.some((annotation) => annotation.id === this.selectedAnnId)) this.selectedAnnId = null;
      this.selectedIds = nextIds;
      this.syncIndexesFromSelection();
    }
    this.commit();
    this.fitPreview();
    this.syncStrip();
    this.setStatus(this.frameStatus());
    void this.paint();
  }

  private deleteSelectedAnnotation(): void {
    if (!this.selectedAnnId) return;
    const id = this.selectedAnnId;
    this.annotations = this.annotations.filter((annotation) => annotation.id !== id);
    this.selectedAnnId = null;
    if (this.editingTextId === id) this.closeTextEditor(false);
    this.commit();
    void this.paint();
  }

  private duplicateSelection(): void {
    if (!this.doc || this.busy || this.selectedIds.length === 0) return;
    this.stopPlayback(false);
    const selected = new Set(this.selectedIds);
    const sourceIds = this.doc.frames.filter((frame) => selected.has(frame.id)).map((frame) => frame.id);
    const result = duplicateFrames(this.doc, this.selectedIds, createId);
    if (result.newIds.length === 0) return;
    this.doc = result.doc;
    this.annotations = cloneAnnotationsForDuplicates(this.annotations, sourceIds, result.newIds, createId);
    this.selectedIds = result.newIds;
    this.syncIndexesFromSelection();
    this.commit();
    this.syncStrip();
    this.strip.reveal(this.focusIndex);
    this.setStatus(this.frameStatus());
    void this.paint();
  }

  private reverseSelection(): void {
    if (!this.doc || this.busy || this.selectedIds.length < 2) return;
    this.stopPlayback(false);
    const next = reverseFrames(this.doc, this.selectedIds);
    if (sameFrameOrder(this.doc.frames, next.frames)) return;
    this.doc = next;
    this.commit();
    this.syncStrip();
    this.setStatus(this.frameStatus());
  }

  private commitDelayFromInput(): void {
    if (!this.doc || this.busy || this.selectedIds.length === 0) return;
    const value = clamp(Math.round(Number(this.delayInput.value) || 0), 0, 60000);
    this.delayInput.value = String(value);
    const selected = new Set(this.selectedIds);
    if (this.doc.frames.every((frame) => !selected.has(frame.id) || frame.delayMs === value)) return;
    this.doc = setDelay(this.doc, this.selectedIds, value);
    this.commit();
    this.syncStrip();
    this.setStatus(this.frameStatus());
  }

  private nudgeDelay(delta: number): void {
    if (!this.doc || this.busy || this.selectedIds.length === 0) return;
    const selected = new Set(this.selectedIds);
    let changed = false;
    const frames = this.doc.frames.map((frame) => {
      if (!selected.has(frame.id)) return frame;
      const delayMs = clamp(frame.delayMs + delta, 0, 60000);
      if (delayMs === frame.delayMs) return frame;
      changed = true;
      return { ...frame, delayMs };
    });
    if (!changed) return;
    this.doc = { ...this.doc, frames };
    this.commit();
    this.syncStrip();
    this.setStatus(this.frameStatus());
  }

  private moveFocus(delta: number, extend: boolean): void {
    if (!this.doc || this.doc.frames.length === 0) return;
    this.stopPlayback(false);
    this.focusIndex = clamp(this.focusIndex + delta, 0, this.doc.frames.length - 1);
    if (extend) this.selectedIds = rangeIds(this.doc.frames, this.anchorIndex, this.focusIndex);
    else {
      this.anchorIndex = this.focusIndex;
      this.selectedIds = [this.doc.frames[this.focusIndex].id];
    }
    this.afterSelectionChange();
    this.setStatus(this.frameStatus());
  }

  private selectAll(): void {
    if (!this.doc || this.doc.frames.length === 0) return;
    this.anchorIndex = 0;
    this.focusIndex = this.doc.frames.length - 1;
    this.selectedIds = rangeIds(this.doc.frames, 0, this.focusIndex);
    this.afterSelectionChange();
  }

  private togglePlay(): void {
    if (!this.doc || this.busy || this.doc.frames.length === 0) return;
    if (this.playing) this.stopPlayback(true);
    else this.play();
  }

  private play(): void {
    if (!this.doc) return;
    this.closeTextEditor(true);
    this.playing = true;
    this.playIndex = clamp(this.focusIndex, 0, this.doc.frames.length - 1);
    this.playAcc = 0;
    this.playLast = 0;
    this.renderChrome();
    this.syncStrip();
    void this.paint();
    this.raf = requestAnimationFrame((time) => this.tick(time));
  }

  private tick(time: number): void {
    if (!this.playing || !this.doc) return;
    if (!this.playLast) this.playLast = time;
    this.playAcc += time - this.playLast;
    this.playLast = time;
    const frame = this.doc.frames[this.playIndex];
    const delay = Math.max(10, frame?.delayMs || 10);
    if (this.playAcc >= delay) {
      this.playAcc = Math.min(this.playAcc - delay, delay);
      const next = this.playIndex + 1;
      if (next >= this.doc.frames.length) {
        if (this.doc.repeat === -1) {
          this.stopPlayback(true);
          this.setStatus(this.frameStatus());
          return;
        }
        this.playIndex = 0;
      } else {
        this.playIndex = next;
      }
      this.strip.reveal(this.playIndex);
      this.syncStrip();
      this.setStatus(this.frameStatus());
      void this.paint();
    }
    this.raf = requestAnimationFrame((now) => this.tick(now));
  }

  private stopPlayback(selectPlayhead: boolean): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    if (selectPlayhead && this.doc) {
      const frame = this.doc.frames[this.playIndex];
      if (frame) {
        this.selectedIds = [frame.id];
        this.focusIndex = this.playIndex;
        this.anchorIndex = this.playIndex;
      }
    }
    this.syncStrip();
    this.renderChrome();
    void this.paint();
  }

  private setTool(tool: Tool): void {
    if (this.busy || !this.doc) return;
    if (tool !== 'crop') this.crop = null;
    if (tool === 'crop') {
      this.resizeBar.hidden = true;
      if (this.tool !== 'crop' || !this.crop) this.crop = defaultCrop(this.doc.width, this.doc.height);
    }
    this.tool = tool;
    this.canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    this.stopPlayback(true);
    this.renderChrome();
    void this.paint();
  }

  private onColor(value: string): void {
    this.color = value;
    const annotation = this.selectedAnnotation();
    if (!annotation || !('color' in annotation) || annotation.color === value) return;
    annotation.color = value;
    if (this.editingTextId === annotation.id) {
      this.textDirty = true;
      this.placeTextArea(annotation as TextAnn);
    } else this.commit();
    void this.paint();
  }

  private onStroke(value: number): void {
    const strokeWidth = clamp(Math.round(value) || 1, 1, 64);
    this.strokeWidth = strokeWidth;
    this.strokeInput.value = String(strokeWidth);
    const annotation = this.selectedAnnotation();
    if (!annotation || !('strokeWidth' in annotation) || annotation.strokeWidth === strokeWidth) return;
    annotation.strokeWidth = strokeWidth;
    this.commit();
    void this.paint();
  }

  private onFontSize(value: number): void {
    const fontSize = clamp(Math.round(value) || 8, 8, 512);
    this.fontSize = fontSize;
    this.fontInput.value = String(fontSize);
    const annotation = this.selectedAnnotation();
    if (!annotation || annotation.type !== 'text' || annotation.fontSize === fontSize) return;
    annotation.fontSize = fontSize;
    if (this.editingTextId === annotation.id) {
      this.textDirty = true;
      this.placeTextArea(annotation);
    } else this.commit();
    void this.paint();
  }

  private onTextBox(background: boolean): void {
    this.textBackground = background;
    const annotation = this.selectedAnnotation();
    if (!annotation || annotation.type !== 'text' || annotation.background === background) return;
    annotation.background = background;
    if (this.editingTextId === annotation.id) {
      this.textDirty = true;
      this.placeTextArea(annotation);
    } else this.commit();
    void this.paint();
  }

  private onPointerDown(event: PointerEvent): void {
    if (!this.doc || this.busy || event.button !== 0 || this.playing) {
      if (this.playing) this.stopPlayback(true);
      if (!this.doc || this.busy || event.button !== 0) return;
    }
    this.hideFrameMenu();
    const point = this.framePoint(event);
    if (!point) return;
    if (this.tool === 'crop') {
      this.captureCanvas(event.pointerId);
      this.beginCrop(point.x, point.y, event.pointerId);
      return;
    }
    const hit = hitTest(this.visibleAnnotations(), point.x, point.y, this.handleSize());
    if (hit || this.tool === 'select') {
      this.captureCanvas(event.pointerId);
      this.beginSelect(point.x, point.y, event.pointerId);
      return;
    }
    if (this.tool === 'text') {
      this.placeText(point.x, point.y);
      return;
    }
    this.captureCanvas(event.pointerId);
    this.beginShape(point.x, point.y, event.pointerId);
  }

  private beginSelect(x: number, y: number, pointerId: number): void {
    const hit = hitTest(this.visibleAnnotations(), x, y, this.handleSize());
    if (!hit) {
      this.selectedAnnId = null;
      this.gesture = null;
      void this.paint();
      return;
    }
    this.selectedAnnId = hit.id;
    this.syncStyleFromSelection();
    const annotation = this.annotationById(hit.id);
    if (!annotation) return;
    const before = structuredClone(this.annotations);
    if (hit.handle === 'body') {
      this.gesture = { kind: 'move', id: hit.id, start: structuredClone(annotation), x, y, before, pointerId, dirty: false };
    } else {
      this.gesture = { kind: 'resize', id: hit.id, handle: hit.handle, start: structuredClone(annotation), before, pointerId, dirty: false };
    }
    void this.paint();
  }

  private beginShape(x: number, y: number, pointerId: number): void {
    const before = structuredClone(this.annotations);
    const annotation = this.makeAnnotation(x, y);
    if (!annotation) return;
    this.annotations = [...this.annotations, annotation];
    this.selectedAnnId = annotation.id;
    this.gesture = { kind: 'new', id: annotation.id, before, pointerId };
    void this.paint();
  }

  private beginCrop(x: number, y: number, pointerId: number): void {
    if (!this.doc) return;
    const current = this.crop ?? defaultCrop(this.doc.width, this.doc.height);
    const hit = hitTest([cropAsRect(current)], x, y, this.handleSize());
    if (hit && hit.handle !== 'body') this.gesture = { kind: 'crop-resize', handle: hit.handle, start: { ...normalizeRect(current.x, current.y, current.w, current.h) }, pointerId };
    else if (hit) this.gesture = { kind: 'crop-move', start: { ...normalizeRect(current.x, current.y, current.w, current.h) }, x, y, pointerId };
    else {
      this.gesture = { kind: 'crop-new', x, y, before: this.crop ? { ...this.crop } : null, pointerId };
      this.crop = { x, y, w: 0, h: 0 };
    }
    void this.paint();
  }

  private onPointerMove(event: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture) {
      this.updateCursor(event);
      return;
    }
    if (event.pointerId !== gesture.pointerId || !this.doc) return;
    const point = this.framePoint(event);
    if (!point) return;
    if (gesture.kind === 'new') this.stretchNew(gesture.id, point.x, point.y);
    else if (gesture.kind === 'move') {
      const dx = point.x - gesture.x;
      const dy = point.y - gesture.y;
      if (dx !== 0 || dy !== 0) gesture.dirty = true;
      this.replaceAnnotation(translateAnnotation(gesture.start, dx, dy));
    } else if (gesture.kind === 'resize') {
      gesture.dirty = true;
      this.replaceAnnotation(resizeAnnotation(gesture.start, gesture.handle, point.x, point.y));
    } else if (gesture.kind === 'crop-new') {
      this.crop = { x: gesture.x, y: gesture.y, w: point.x - gesture.x, h: point.y - gesture.y };
    } else if (gesture.kind === 'crop-move') {
      const width = gesture.start.w;
      const height = gesture.start.h;
      this.crop = {
        x: clamp(gesture.start.x + (point.x - gesture.x), 0, this.doc.width - width),
        y: clamp(gesture.start.y + (point.y - gesture.y), 0, this.doc.height - height),
        w: width,
        h: height,
      };
    } else if (gesture.kind === 'crop-resize') {
      const resized = resizeAnnotation(cropAsRect(gesture.start), gesture.handle, point.x, point.y);
      if (resized.type === 'rect') this.crop = clampCrop(resized, this.doc.width, this.doc.height);
    }
    void this.paint();
  }

  private stretchNew(id: string, x: number, y: number): void {
    const annotation = this.annotationById(id);
    if (!annotation) return;
    if (annotation.type === 'arrow') this.replaceAnnotation({ ...annotation, x2: x, y2: y });
    else if (annotation.type === 'pen') {
      const last = annotation.points[annotation.points.length - 1];
      if (!last || Math.hypot(x - last.x, y - last.y) >= 1) {
        this.replaceAnnotation({ ...annotation, points: [...annotation.points, { x, y }] });
      }
    } else if (annotation.type === 'rect' || annotation.type === 'highlight' || annotation.type === 'blur') {
      this.replaceAnnotation({ ...annotation, w: x - annotation.x, h: y - annotation.y });
    }
  }

  private onPointerUp(event: PointerEvent): void {
    try {
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    } catch {
      /* The pointer can already be inactive. */
    }
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    this.gesture = null;
    if (gesture.kind === 'new') {
      const annotation = this.annotationById(gesture.id);
      if (!annotation || !isDrawable(annotation)) {
        this.annotations = gesture.before;
        if (this.selectedAnnId === gesture.id) this.selectedAnnId = null;
      } else {
        this.replaceAnnotation(normalizeAnnotation(annotation));
        this.selectedAnnId = annotation.id;
        this.tool = 'select';
        this.canvas.style.cursor = 'default';
        this.commit();
      }
    } else if ((gesture.kind === 'move' || gesture.kind === 'resize') && gesture.dirty) {
      const annotation = this.annotationById(gesture.id);
      if (annotation) this.replaceAnnotation(normalizeAnnotation(annotation));
      this.syncStyleFromSelection();
      this.commit();
    } else if (gesture.kind === 'crop-new' && this.doc) {
      const rect = this.crop ? clampCrop(this.crop, this.doc.width, this.doc.height) : null;
      if (!rect || rect.w < 2 || rect.h < 2) this.crop = gesture.before ?? defaultCrop(this.doc.width, this.doc.height);
      else this.crop = rect;
    } else if (this.crop && this.doc && (gesture.kind === 'crop-move' || gesture.kind === 'crop-resize')) {
      this.crop = clampCrop(this.crop, this.doc.width, this.doc.height);
    }
    void this.paint();
    this.renderChrome();
  }

  private onPointerCancel(event: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    this.gesture = null;
    if (gesture.kind === 'new' || gesture.kind === 'move' || gesture.kind === 'resize') this.annotations = gesture.before;
    else if (gesture.kind === 'crop-new') this.crop = gesture.before;
    void this.paint();
  }

  private onDoubleClick(event: MouseEvent): void {
    if (this.tool === 'crop' || !this.doc || this.busy) return;
    const point = this.framePoint(event);
    if (!point) return;
    const hit = hitTest(this.visibleAnnotations(), point.x, point.y, this.handleSize());
    const annotation = hit ? this.annotationById(hit.id) : null;
    if (annotation?.type === 'text') this.openTextEditor(annotation);
  }

  private placeText(x: number, y: number): void {
    const annotation: TextAnn = {
      id: createId(),
      type: 'text',
      x,
      y,
      text: '',
      fontSize: this.fontSize,
      color: this.color,
      background: this.textBackground,
    };
    this.annotations = [...this.annotations, annotation];
    this.selectedAnnId = annotation.id;
    this.openTextEditor(annotation);
  }

  private openTextEditor(annotation: TextAnn): void {
    this.stopPlayback(true);
    this.editingTextId = annotation.id;
    this.textBefore = annotation.text;
    this.textDirty = false;
    this.textArea.hidden = false;
    this.textArea.value = annotation.text;
    this.placeTextArea(annotation);
    this.textArea.focus();
    void this.paint();
  }

  private placeTextArea(annotation: TextAnn): void {
    const scale = this.viewScale || 1;
    this.textArea.style.left = `${annotation.x * scale}px`;
    this.textArea.style.top = `${annotation.y * scale}px`;
    this.textArea.style.fontSize = `${annotation.fontSize * scale}px`;
    this.textArea.style.color = annotation.color;
    this.textArea.style.background = annotation.background ? (isDarkColor(annotation.color) ? '#ffffff' : '#111111') : 'transparent';
    this.textArea.style.width = `${Math.max(48, textWidth(annotation.text || ' ', annotation.fontSize) * scale + 12)}px`;
    this.textArea.style.height = `${Math.max(24, annotation.fontSize * scale * 1.4)}px`;
  }

  private onTextInput(): void {
    const annotation = this.editingText();
    if (!annotation) return;
    annotation.text = this.textArea.value;
    this.placeTextArea(annotation);
    void this.paint();
  }

  private onTextBlur(): void {
    if (this.ignoreTextBlur) return;
    const annotation = this.editingText();
    const text = this.textArea.value;
    const before = this.textBefore;
    const dirty = this.textDirty;
    this.textArea.hidden = true;
    this.editingTextId = null;
    this.textDirty = false;
    if (!annotation) return;
    if (text.trim() === '') {
      this.annotations = this.annotations.filter((item) => item.id !== annotation.id);
      if (this.selectedAnnId === annotation.id) this.selectedAnnId = null;
      if (before.trim() !== '') this.commit();
      void this.paint();
      this.renderChrome();
      return;
    }
    annotation.text = text;
    if (this.tool === 'text') {
      this.tool = 'select';
      this.canvas.style.cursor = 'default';
    }
    if (text !== before || dirty) this.commit();
    this.renderChrome();
    void this.paint();
  }

  private closeTextEditor(commit: boolean): void {
    if (!this.editingTextId) {
      this.textArea.hidden = true;
      return;
    }
    if (!commit) {
      this.ignoreTextBlur = true;
      this.textArea.blur();
      this.ignoreTextBlur = false;
      this.textArea.hidden = true;
      this.editingTextId = null;
      return;
    }
    this.textArea.blur();
  }

  private makeAnnotation(x: number, y: number): Annotation | null {
    const id = createId();
    if (this.tool === 'arrow') {
      return { id, type: 'arrow', x1: x, y1: y, x2: x, y2: y, color: this.color, strokeWidth: this.strokeWidth };
    }
    if (this.tool === 'rect') {
      return { id, type: 'rect', x, y, w: 0, h: 0, color: this.color, strokeWidth: this.strokeWidth };
    }
    if (this.tool === 'pen') {
      return { id, type: 'pen', points: [{ x, y }], color: this.color, strokeWidth: this.strokeWidth };
    }
    if (this.tool === 'highlight') return { id, type: 'highlight', x, y, w: 0, h: 0 };
    if (this.tool === 'blur') return { id, type: 'blur', x, y, w: 0, h: 0, radius: BLUR_RADIUS };
    return null;
  }

  private applyDrawings(): void {
    if (!this.doc || this.busy || this.annotations.length === 0) return;
    this.closeTextEditor(true);
    if (this.annotations.length === 0) return;
    const frame = this.primaryFrame();
    const ids = this.selectedIds.length > 0 ? [...this.selectedIds] : frame ? [frame.id] : [];
    if (ids.length === 0) {
      this.setStatus('Select a frame first.');
      return;
    }
    const next = assignAnnotationFrames(this.annotations, ids, this.selectedAnnId);
    const unchanged = next.every((annotation, index) => sameFrameIds(annotation.frameIds, this.annotations[index]?.frameIds));
    if (unchanged) {
      this.setStatus('Those frames already show these drawings.');
      return;
    }
    this.annotations = next;
    this.commit();
    this.renderChrome();
    void this.paint();
    const count = ids.length;
    this.setStatus(`Drawings stay editable on ${count} ${count === 1 ? 'frame' : 'frames'} until export.`);
  }

  private async applyCrop(): Promise<void> {
    if (!this.doc || !this.crop || this.busy) return;
    const rect = clampCrop(this.crop, this.doc.width, this.doc.height);
    if (rect.x === 0 && rect.y === 0 && rect.w === this.doc.width && rect.h === this.doc.height) {
      this.setStatus('Crop matches the full frame.');
      return;
    }
    this.crop = rect;
    await this.runTransform('crop');
  }

  private openResize(): void {
    if (!this.doc || this.busy) return;
    this.resizeWidth.value = String(this.doc.width);
    this.resizeHeight.value = String(this.doc.height);
    this.resizeRatio = this.doc.width / this.doc.height;
    this.resizeLock.checked = true;
    this.resizeBar.hidden = false;
  }

  private onResizeInput(source: 'w' | 'h'): void {
    if (this.syncingSize || !this.resizeLock.checked) return;
    this.syncingSize = true;
    if (source === 'w') {
      const width = clamp(Math.round(Number(this.resizeWidth.value) || 1), 1, MAX_EDGE);
      this.resizeHeight.value = String(clamp(Math.round(width / this.resizeRatio), 1, MAX_EDGE));
    } else {
      const height = clamp(Math.round(Number(this.resizeHeight.value) || 1), 1, MAX_EDGE);
      this.resizeWidth.value = String(clamp(Math.round(height * this.resizeRatio), 1, MAX_EDGE));
    }
    this.syncingSize = false;
  }

  private async applyResize(): Promise<void> {
    if (!this.doc || this.busy) return;
    const width = clamp(Math.round(Number(this.resizeWidth.value) || 1), 1, MAX_EDGE);
    const height = clamp(Math.round(Number(this.resizeHeight.value) || 1), 1, MAX_EDGE);
    this.resizeWidth.value = String(width);
    this.resizeHeight.value = String(height);
    if (width === this.doc.width && height === this.doc.height) {
      this.setStatus('Size is unchanged.');
      return;
    }
    await this.runTransform('resize');
  }

  private async runTransform(op: 'crop' | 'resize'): Promise<boolean> {
    const doc = this.doc;
    if (!doc) return false;
    this.stopPlayback(false);
    this.closeTextEditor(true);
    const live = this.doc;
    if (!live) return false;
    this.busy = true;
    this.renderChrome();
    this.setStatus(op === 'crop' ? 'Cropping...' : 'Resizing...');
    try {
      const targets = live.frames;
      if (targets.length === 0) throw new Error('Select a frame first.');
      const frames = await Promise.all(
        targets.map(async (frame) => ({
          id: frame.id,
          pixels: await frame.pixels.arrayBuffer(),
        })),
      );
      const crop = this.crop ? clampCrop(this.crop, live.width, live.height) : undefined;
      const result = await this.client.transform({
        op,
        width: live.width,
        height: live.height,
        frames,
        crop: op === 'crop' ? crop : undefined,
        targetWidth: op === 'resize' ? clamp(Math.round(Number(this.resizeWidth.value) || live.width), 1, MAX_EDGE) : undefined,
        targetHeight: op === 'resize' ? clamp(Math.round(Number(this.resizeHeight.value) || live.height), 1, MAX_EDGE) : undefined,
      });
      const byId = new Map(result.frames.map((frame) => [frame.id, frame]));
      this.doc = {
        ...live,
        width: result.width,
        height: result.height,
        frames: live.frames.map((frame) => {
          const next = byId.get(frame.id);
          if (!next) return frame;
          return {
            ...frame,
            pixels: new Blob([next.pixels]),
            thumb: new Blob([next.thumb], { type: 'image/png' }),
          };
        }),
      };
      if (op === 'crop' && crop) this.annotations = cropAnnotations(this.annotations, crop);
      else if (op === 'resize') this.annotations = scaleAnnotations(this.annotations, result.width / live.width, result.height / live.height);
      if (this.selectedAnnId && !this.annotations.some((annotation) => annotation.id === this.selectedAnnId)) this.selectedAnnId = null;
      this.crop = null;
      this.tool = 'select';
      this.resizeBar.hidden = true;
      this.cache.clear();
      this.commit();
      this.fitPreview();
      this.syncStrip();
      this.setStatus(this.frameStatus());
      return true;
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : 'Could not update the frames.');
      return false;
    } finally {
      this.busy = false;
      this.renderChrome();
      void this.paint();
    }
  }

  private openExport(): void {
    if (!this.doc || this.busy) return;
    this.hideFrameMenu();
    this.exportModal.hidden = false;
    this.refreshExportHint();
    this.scheduleEstimate();
  }

  private closeExport(): void {
    this.exportModal.hidden = true;
    this.estimateToken += 1;
    this.client.cancelEncode();
  }

  private toggleHelp(): void {
    this.helpOverlay.hidden = !this.helpOverlay.hidden;
  }

  private scheduleEstimate(): void {
    if (this.exportModal.hidden || !this.doc) return;
    const token = ++this.estimateToken;
    this.exportSize.textContent = 'Estimating...';
    window.setTimeout(() => {
      if (token !== this.estimateToken) return;
      void this.runEstimate(token);
    }, 200);
  }

  private async runEstimate(token: number): Promise<void> {
    const key = this.exportKey();
    try {
      const bytes = await this.encodeBytes(() => token === this.estimateToken && !this.exporting);
      if (token !== this.estimateToken) return;
      if (key !== this.exportKey()) {
        this.scheduleEstimate();
        return;
      }
      this.exportCache = { key, bytes };
      this.exportSize.textContent = formatBytes(bytes.byteLength);
    } catch (error) {
      if (error instanceof Error && error.message === 'Cancelled') return;
      if (token !== this.estimateToken) return;
      this.exportSize.textContent = error instanceof Error ? error.message : 'Could not estimate the size.';
    }
  }

  private async downloadExport(): Promise<void> {
    if (!this.doc || this.busy || this.exporting) return;
    const exportName = gifFileName(this.doc.name);
    this.exporting = true;
    this.estimateToken += 1;
    this.client.cancelEncode();
    this.exportDownload.disabled = true;
    this.exportSize.textContent = 'Exporting...';
    try {
      const key = this.exportKey();
      let bytes = this.exportCache?.key === key ? this.exportCache.bytes : null;
      if (!bytes) bytes = await this.encodeBytes(() => this.exporting);
      const file = new Uint8Array(bytes);
      downloadBlob(new Blob([file], { type: 'image/gif' }), exportName);
      this.closeExport();
    } catch (error) {
      if (!(error instanceof Error && error.message === 'Cancelled')) {
        this.exportSize.textContent = error instanceof Error ? error.message : 'Could not export.';
      }
    } finally {
      this.exporting = false;
      this.exportDownload.disabled = false;
    }
  }

  private async encodeBytes(guard: () => boolean): Promise<Uint8Array> {
    const doc = this.doc;
    if (!doc || doc.frames.length === 0) throw new Error('Nothing to export.');
    const annotations = this.annotations;
    const frames = await Promise.all(
      doc.frames.map(async (frame) => {
        const visible = annotationsOnFrame(annotations, frame.id);
        return {
          delayMs: frame.delayMs,
          pixels: await frame.pixels.arrayBuffer(),
          annotations: visible.length > 0 ? structuredClone(visible) : undefined,
        };
      }),
    );
    if (!guard()) throw new Error('Cancelled');
    return this.client.encode(
      {
        width: doc.width,
        height: doc.height,
        repeat: doc.repeat,
        maxColors: this.exportColors(),
        dither: this.exportDither(),
        scale: this.exportScale(),
        frames,
      },
      (index, total) => {
        if (!this.exportModal.hidden && this.exporting) this.exportSize.textContent = `Exporting ${index} / ${total}`;
      },
    );
  }

  private exportKey(): string {
    const doc = this.doc;
    if (!doc) return '';
    return JSON.stringify({
      revision: this.revision,
      width: doc.width,
      height: doc.height,
      repeat: doc.repeat,
      colors: this.exportColors(),
      dither: this.exportDither(),
      scale: this.exportScale(),
      frames: doc.frames.map((frame) => [frame.id, frame.delayMs, frame.pixels.size]),
      selected: this.selectedIds,
      annotations: this.annotations,
    });
  }

  private exportColors(): number {
    return clamp(Math.round(Number(this.colorsInput.value) || 256), 2, 256);
  }

  private exportDither(): 'none' | 'floyd' {
    return this.ditherInput.value === 'none' ? 'none' : 'floyd';
  }

  private exportScale(): number {
    const value = Number(this.scaleInput.value);
    return value > 0 ? value : 1;
  }

  private refreshExportHint(): void {
    const frames = this.doc?.frames ?? [];
    if (this.annotations.length === 0 || frames.length === 0) {
      this.exportHint.hidden = true;
      return;
    }
    this.exportHint.hidden = false;
    const count = frames.filter((frame) => annotationsOnFrame(this.annotations, frame.id).length > 0).length;
    this.exportHint.textContent =
      count === frames.length
        ? 'Drawings stay editable here and are included in the file.'
        : `Drawings stay editable here and are included on ${count} ${count === 1 ? 'frame' : 'frames'}.`;
  }

  private async exportPng(): Promise<void> {
    const doc = this.doc;
    const frame = this.visibleFrame();
    if (!doc || !frame || this.busy) return;
    const bitmap = await this.cache.get(frame, doc.width, doc.height);
    const canvas = document.createElement('canvas');
    canvas.width = doc.width;
    canvas.height = doc.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(bitmap, 0, 0);
    drawAnnotations(ctx, annotationsOnFrame(this.annotations, frame.id));
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return;
    const index = Math.max(0, doc.frames.findIndex((item) => item.id === frame.id));
    downloadBlob(blob, `frame-${index + 1}.png`);
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (isTypingTarget(event.target)) {
      if (event.key === 'Escape' && event.target instanceof HTMLElement) event.target.blur();
      return;
    }
    const meta = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (event.key === 'Escape') {
      if (!this.frameMenu.hidden) {
        this.hideFrameMenu();
        return;
      }
      if (!this.exportModal.hidden) this.closeExport();
      else if (!this.helpOverlay.hidden) this.helpOverlay.hidden = true;
      else if (this.editingTextId) this.textArea.blur();
      else if (this.tool === 'crop') this.setTool('select');
      else if (this.confirmMode) this.hideConfirm();
      else if (!this.resizeBar.hidden) this.resizeBar.hidden = true;
      return;
    }
    if (event.key === '?' ) {
      event.preventDefault();
      this.toggleHelp();
      return;
    }
    if (meta && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (meta && key === 'd') {
      event.preventDefault();
      if (!event.repeat) this.duplicateSelection();
      return;
    }
    if (meta && key === 'a') {
      event.preventDefault();
      this.selectAll();
      return;
    }
    if (meta && key === 'e') {
      event.preventDefault();
      if (event.shiftKey) void this.exportPng();
      else this.openExport();
      return;
    }
    if (meta && key === 'o') {
      event.preventDefault();
      this.fileInput.click();
      return;
    }
    if (meta && event.key === 'Enter') {
      event.preventDefault();
      this.applyDrawings();
      return;
    }
    if (event.key === ' ' && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      if (!event.repeat) this.togglePlay();
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      this.moveFocus(event.key === 'ArrowLeft' ? -1 : 1, event.shiftKey);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (!this.doc) return;
      const index = event.key === 'Home' ? 0 : this.doc.frames.length - 1;
      this.moveFocus(index - this.focusIndex, event.shiftKey);
      return;
    }
    if (!meta && !event.altKey && (event.key === '[' || event.key === ']')) {
      event.preventDefault();
      this.nudgeDelay(event.key === ']' ? 10 : -10);
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !meta) {
      event.preventDefault();
      if (!event.repeat) {
        if (this.tool === 'crop') return;
        if (this.selectedAnnId) this.deleteSelectedAnnotation();
        else this.deleteSelectedFrames();
      }
      return;
    }
    if (meta || event.altKey || event.repeat) return;
    const tool = TOOLS.find((item) => item.key.toLowerCase() === key)?.tool;
    if (tool) this.setTool(tool);
    else if (key === 'c') this.setTool('crop');
  }

  private fitPreview(): void {
    const doc = this.doc;
    if (!doc) {
      this.canvas.width = 1;
      this.canvas.height = 1;
      this.canvas.style.width = '0px';
      this.canvas.style.height = '0px';
      this.viewScale = 1;
      return;
    }
    if (this.canvas.width !== doc.width || this.canvas.height !== doc.height) {
      this.canvas.width = doc.width;
      this.canvas.height = doc.height;
    }
    const bounds = this.stage.getBoundingClientRect();
    const maxW = Math.max(1, bounds.width - 32);
    const maxH = Math.max(1, bounds.height - 32);
    const scale = Math.min(maxW / doc.width, maxH / doc.height);
    this.canvas.style.imageRendering = scale > 1 ? 'pixelated' : 'auto';
    const cssW = Math.max(1, Math.floor(doc.width * scale));
    const cssH = Math.max(1, Math.floor(doc.height * scale));
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.viewScale = cssW / doc.width;
    if (this.editingTextId) {
      const annotation = this.editingText();
      if (annotation) this.placeTextArea(annotation);
    }
  }

  private async paint(): Promise<void> {
    const token = ++this.paintToken;
    const doc = this.doc;
    if (!doc) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    const frame = this.visibleFrame();
    if (!frame) return;
    let bitmap: ImageBitmap;
    try {
      bitmap = await this.cache.get(frame, doc.width, doc.height);
    } catch {
      return;
    }
    if (token !== this.paintToken || this.doc !== doc) return;
    this.ctx.clearRect(0, 0, doc.width, doc.height);
    this.ctx.drawImage(bitmap, 0, 0);
    const frameAnnotations = annotationsOnFrame(this.annotations, frame.id);
    drawAnnotations(this.ctx, frameAnnotations, this.editingTextId);
    const handle = this.handleSize();
    const selected = this.selectedAnnotation();
    if (!this.playing && this.gesture?.kind !== 'new' && this.tool !== 'crop' && selected && frameAnnotations.some((annotation) => annotation.id === selected.id)) {
      drawHandles(this.ctx, selected, handle);
    }
    if (this.tool === 'crop' && this.crop) {
      drawCropOverlay(this.ctx, this.crop);
      drawHandles(this.ctx, cropAsRect(this.crop), handle);
    }
    this.prefetch(doc, doc.frames.indexOf(frame));
  }

  private prefetch(doc: Doc, index: number): void {
    if (index < 0) return;
    for (const offset of [1, 2]) {
      let next = index + offset;
      if (next >= doc.frames.length) {
        if (doc.repeat === -1) continue;
        next %= doc.frames.length;
      }
      const frame = doc.frames[next];
      if (frame) void this.cache.get(frame, doc.width, doc.height).catch(() => undefined);
    }
  }

  private syncStrip(): void {
    const frames = this.doc?.frames ?? [];
    const active = this.playing ? this.playIndex : this.focusIndex;
    this.strip.setState(frames, this.selectedIds, active);
  }

  private renderChrome(): void {
    const has = Boolean(this.doc && this.doc.frames.length > 0);
    const locked = this.busy;
    this.root.classList.toggle('busy', locked);
    this.openButton.disabled = locked;
    this.newButton.disabled = locked || !has;
    this.undoButton.disabled = locked || !this.history.canUndo;
    this.redoButton.disabled = locked || !this.history.canRedo;
    this.deleteButton.disabled = locked || !has;
    this.duplicateButton.disabled = locked || !has;
    this.reverseButton.disabled = locked || this.selectedIds.length < 2;
    this.delayInput.disabled = locked || !has;
    this.playButton.disabled = locked || !has;
    this.playButton.textContent = this.playing ? 'Pause' : 'Play';
    this.loopInput.disabled = locked || !has;
    if (this.doc) this.loopInput.checked = this.doc.repeat !== -1;
    for (const toolButton of this.toolButtons) {
      toolButton.disabled = locked || !has;
      toolButton.setAttribute('aria-pressed', toolButton.dataset.tool === this.tool ? 'true' : 'false');
    }
    this.colorInput.disabled = locked || !has;
    this.strokeInput.disabled = locked || !has;
    this.fontInput.disabled = locked || !has;
    this.textBoxInput.disabled = locked || !has;
    const count = this.selectedIds.length || (has ? 1 : 0);
    this.applyButton.disabled = locked || !has || this.annotations.length === 0;
    this.applyButton.textContent = this.annotations.length > 0 && count > 0 ? `Apply to ${count} ${count === 1 ? 'frame' : 'frames'}` : 'Apply';
    this.cropButton.disabled = locked || !has;
    this.cropButton.setAttribute('aria-pressed', this.tool === 'crop' ? 'true' : 'false');
    this.resizeButton.disabled = locked || !has;
    this.pngButton.disabled = locked || !has;
    this.exportButton.disabled = locked || !has;
    this.syncDelay();
    this.empty.hidden = this.doc !== null;
    this.cropBar.hidden = this.tool !== 'crop';
    if (!this.exportModal.hidden) this.refreshExportHint();
  }

  private syncDelay(): void {
    if (document.activeElement === this.delayInput) return;
    const frame = this.primaryFrame();
    this.delayInput.value = frame ? String(frame.delayMs) : '';
  }

  private syncIndexesFromSelection(): void {
    if (!this.doc || this.selectedIds.length === 0) {
      this.focusIndex = 0;
      this.anchorIndex = 0;
      return;
    }
    const last = this.selectedIds[this.selectedIds.length - 1];
    const first = this.selectedIds[0];
    const focus = this.doc.frames.findIndex((frame) => frame.id === last);
    const anchor = this.doc.frames.findIndex((frame) => frame.id === first);
    this.focusIndex = Math.max(0, focus);
    this.anchorIndex = Math.max(0, anchor);
  }

  private frameStatus(): string {
    const doc = this.doc;
    const frame = this.visibleFrame();
    if (!doc || !frame) return '';
    const index = Math.max(0, doc.frames.findIndex((item) => item.id === frame.id));
    return `Frame ${index + 1} of ${doc.frames.length} - ${doc.width}x${doc.height} - ${frame.delayMs} ms`;
  }

  private setStatus(text: string): void {
    this.statusText.textContent = text;
  }

  private primaryFrame(): Frame | null {
    if (!this.doc || this.doc.frames.length === 0) return null;
    if (this.selectedIds.length === 0) return this.doc.frames[Math.min(this.focusIndex, this.doc.frames.length - 1)] ?? null;
    const id = this.selectedIds[this.selectedIds.length - 1];
    return this.doc.frames.find((frame) => frame.id === id) ?? this.doc.frames[0] ?? null;
  }

  private visibleFrame(): Frame | null {
    if (this.playing && this.doc) return this.doc.frames[this.playIndex] ?? this.primaryFrame();
    return this.primaryFrame();
  }

  private selectedAnnotation(): Annotation | null {
    if (!this.selectedAnnId) return null;
    return this.annotationById(this.selectedAnnId);
  }

  private annotationById(id: string): Annotation | null {
    return this.annotations.find((annotation) => annotation.id === id) ?? null;
  }

  private editingText(): TextAnn | null {
    const annotation = this.editingTextId ? this.annotationById(this.editingTextId) : null;
    return annotation?.type === 'text' ? annotation : null;
  }

  private replaceAnnotation(next: Annotation): void {
    this.annotations = this.annotations.map((annotation) => (annotation.id === next.id ? next : annotation));
  }

  private framePoint(event: MouseEvent): { x: number; y: number } | null {
    if (!this.doc) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: ((event.clientX - rect.left) * this.doc.width) / rect.width,
      y: ((event.clientY - rect.top) * this.doc.height) / rect.height,
    };
  }

  private handleSize(): number {
    return Math.max(3, 7 / (this.viewScale || 1));
  }

  private syncStyleFromSelection(): void {
    const annotation = this.selectedAnnotation();
    if (!annotation) return;
    if ('color' in annotation) {
      this.color = annotation.color;
      this.colorInput.value = annotation.color;
    }
    if ('strokeWidth' in annotation) {
      this.strokeWidth = annotation.strokeWidth;
      this.strokeInput.value = String(annotation.strokeWidth);
    }
    if (annotation.type === 'text') {
      this.fontSize = annotation.fontSize;
      this.fontInput.value = String(annotation.fontSize);
      this.textBackground = annotation.background;
      this.textBoxInput.checked = annotation.background;
    }
  }

  private visibleAnnotations(): Annotation[] {
    const frame = this.visibleFrame();
    if (!frame) return [];
    return annotationsOnFrame(this.annotations, frame.id);
  }

  private captureCanvas(pointerId: number): void {
    try {
      this.canvas.setPointerCapture(pointerId);
    } catch {
      /* The pointer can already be inactive. */
    }
  }

  private updateCursor(event: PointerEvent): void {
    if (!this.doc || this.busy) {
      this.canvas.style.cursor = '';
      return;
    }
    if (this.tool === 'crop') {
      this.canvas.style.cursor = 'crosshair';
      return;
    }
    const point = this.framePoint(event);
    if (!point) return;
    const hit = hitTest(this.visibleAnnotations(), point.x, point.y, this.handleSize());
    if (!hit) {
      this.canvas.style.cursor = this.tool === 'select' ? 'default' : 'crosshair';
      return;
    }
    const moving = hit.handle === 'body' || hit.handle === 'start' || hit.handle === 'end';
    this.canvas.style.cursor = moving ? 'move' : cursorForHandle(hit.handle);
  }

  private showFrameMenu(event: StripMenu): void {
    if (!this.doc || this.busy) return;
    this.stopPlayback(false);
    const frame = this.doc.frames[event.index];
    if (!frame) return;
    if (!this.selectedIds.includes(frame.id)) {
      this.anchorIndex = event.index;
      this.focusIndex = event.index;
      this.selectedIds = [frame.id];
      this.afterSelectionChange();
    }
    this.frameMenuReverse.disabled = this.selectedIds.length < 2;
    this.frameMenu.hidden = false;
    this.frameMenu.style.left = '0px';
    this.frameMenu.style.top = '0px';
    const rect = this.frameMenu.getBoundingClientRect();
    const left = Math.max(8, Math.min(event.x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(event.y, window.innerHeight - rect.height - 8));
    this.frameMenu.style.left = `${left}px`;
    this.frameMenu.style.top = `${top}px`;
  }

  private hideFrameMenu(): void {
    this.frameMenu.hidden = true;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function menuItem(label: string, hint: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.setAttribute('role', 'menuitem');
  node.append(document.createTextNode(label));
  if (hint) {
    const shortcut = document.createElement('kbd');
    shortcut.textContent = hint;
    node.append(shortcut);
  }
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return node;
}

function cursorForHandle(handle: string): string {
  if (handle === 'n' || handle === 's') return 'ns-resize';
  if (handle === 'e' || handle === 'w') return 'ew-resize';
  if (handle === 'ne' || handle === 'sw') return 'nesw-resize';
  return 'nwse-resize';
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  if (title) node.title = title;
  node.addEventListener('click', onClick);
  return node;
}

function numInput(min: number, max: number, value: number, label: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = '1';
  input.value = String(value);
  input.ariaLabel = label;
  return input;
}

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function group(...nodes: Node[]): HTMLDivElement {
  const node = el('div', 'group');
  node.append(...nodes);
  return node;
}

function isGifFile(file: File): boolean {
  return file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function defaultCrop(width: number, height: number): Rect {
  const x = Math.round(width * 0.1);
  const y = Math.round(height * 0.1);
  return { x, y, w: Math.max(1, width - x * 2), h: Math.max(1, height - y * 2) };
}

function clampCrop(rect: Rect, width: number, height: number): Rect {
  const normalized = normalizeRect(rect.x, rect.y, rect.w, rect.h);
  let x = Math.round(normalized.x);
  let y = Math.round(normalized.y);
  let w = Math.max(1, Math.round(normalized.w));
  let h = Math.max(1, Math.round(normalized.h));
  x = clamp(x, 0, Math.max(0, width - 1));
  y = clamp(y, 0, Math.max(0, height - 1));
  w = Math.max(1, Math.min(w, width - x));
  h = Math.max(1, Math.min(h, height - y));
  return { x, y, w, h };
}

function cropAsRect(crop: Rect): RectAnn {
  return { id: 'crop', type: 'rect', x: crop.x, y: crop.y, w: crop.w, h: crop.h, color: '#ffffff', strokeWidth: 1 };
}

function normalizeAnnotation(annotation: Annotation): Annotation {
  if (annotation.type === 'rect' || annotation.type === 'highlight' || annotation.type === 'blur') {
    return { ...annotation, ...normalizeRect(annotation.x, annotation.y, annotation.w, annotation.h) };
  }
  return annotation;
}

function gifFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'edited.gif';
  const base = trimmed.replace(/\.gif$/i, '');
  if (!base) return 'edited.gif';
  return `${base}-edited.gif`;
}

function isDarkColor(color: string): boolean {
  if (!/^#[0-9a-fA-F]{6}$/.test(color.trim())) return false;
  const value = Number.parseInt(color.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 < 150;
}
