# Task: Build a browser-based, offline GIF editor (ScreenToGif-style), hosted on GitHub Pages

## Context
ScreenToGif (Windows) has an excellent frame editor: you open a GIF, see every frame as a thumbnail strip, delete/duplicate frames, adjust per-frame delay, draw annotations (arrows, rectangles, text) on individual frames, and export. Nothing comparable exists for macOS. We want that editor experience as a static web app.

You own planning, architecture and implementation. This document defines what, not how.

## Hard constraints
- Static site, deployable to GitHub Pages (plain files under a repo, no server). Must work when opened from `https://<user>.github.io/<repo>/`.
- Fully client-side and offline-capable after first load: no uploads, no backend, no API calls, no telemetry. The user's GIF never leaves the browser.
- Works in current Chrome and Safari on macOS. Mobile is not a target.
- Free/open-source dependencies only. Rust/WASM is allowed where it earns its place (e.g. GIF encoding with gifski-quality output), but is not required. Do not add it for its own sake; a pure TypeScript build is acceptable if quality and performance are good.
- Handle GIFs up to ~1000 frames at 1920×1080 without freezing the UI (use workers / OffscreenCanvas where needed).

## Phase 1 (this task): open and edit an existing GIF
Must-have, in priority order:
1. Open a GIF via file picker or drag-and-drop. Decode all frames correctly, including GIFs that use frame disposal methods and partial-frame updates (every frame must render as the user sees it when the GIF plays, not as raw sub-images).
2. Frame strip: all frames as thumbnails with index and delay. Click to select, shift/cmd-click for ranges. Keyboard navigation (←/→, Home/End).
3. Frame operations on the selection: delete, duplicate, move (drag to reorder), set delay (ms), reverse selection. Undo/redo for everything (cmd-Z / shift-cmd-Z).
4. Preview: large view of the selected frame, play/pause of the whole animation at real speed, loop.
5. Annotation tools on the selected frame(s): arrow, rectangle (outline, configurable stroke width and color), freehand pen, text (font size, color, optional background box), and a highlight/blur rectangle. Annotations must be movable/resizable/deletable before they are committed; applying to a range of frames at once must be supported (e.g. draw an arrow once, apply to frames 12–30).
6. Crop and resize the whole animation.
7. Export as GIF with quality/size controls (colors, dithering, scale). Output must look at least as good as the input; show the estimated file size before download. Also export the current frame as PNG.
8. Autosave the working state to IndexedDB so a reload does not lose work; offer "New / discard".

Non-goals for phase 1: screen recording, webcam, video import, effects/transitions, cloud anything, accounts.

## Phase 2 (later, design for it but do not build now)
Screen recording in the browser via `getDisplayMedia`, feeding frames straight into the same editor. Keep the frame model independent of the GIF decoder so a recorder can produce frames too.

## Quality bar
- The editor must feel immediate: selecting a frame, deleting, undo are < 50 ms perceived.
- Keyboard shortcuts for all frequent operations, shown in a help overlay (`?`).
- Clean, minimal UI. No onboarding, no modals except file open/export. Dark and light theme following the OS.
- Deterministic export: same input + same operations → same output.

## Process requirements
- Start by writing a short plan (architecture, stack choice with reasons, frame model, how disposal methods will be handled, how undo is modeled). Then build in vertical slices: open+strip+preview → frame ops+undo → export → annotations → crop/resize → autosave. Each slice must be usable on its own.
- Write tests for the GIF decoder (disposal methods, transparency, looping), the frame-edit model (undo/redo correctness) and the exporter (round-trip a GIF with no edits and compare frames). Include a few real-world sample GIFs in the repo for tests.
- I will run the app manually after each slice and give feedback. Ask me for a screenshot or a sample GIF when you need visual confirmation; do not guess at UI results.
- Set up a GitHub Actions workflow that builds and deploys to GitHub Pages on push to main.
- Keep the README short: what it does, how to run locally, how to deploy.

## Deliverable
A repo that, when pushed, publishes a working editor to GitHub Pages where I can open a GIF, delete and duplicate frames, draw arrows and boxes on frames, and download the result — all without a network connection after the page loads.
