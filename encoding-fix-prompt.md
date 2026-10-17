# Task: Fix GIF export bloat (23x larger than source) in src/gif/encode.ts

## Problem
Exporting `samples/better-rename-clean.gif` (464 KB, 180 frames, 1200x700) after
deleting ~37 frames produces `samples/better-rename-clean-edited.gif` at 10.6 MB.
Fewer frames, 23x larger. Measured per-frame cost: 2.6 KB in the source vs 74 KB
in our output.

## Root cause (verified by inspecting both files)
`createGifSink` in `src/gif/encode.ts` writes every frame as a full 1200x700
image with `dispose: 2` and a fresh per-frame local palette. The source file
instead writes only the changed bounding box per frame (179 of 180 frames are
partial rectangles) with `dispose: 1` and one global palette. Screen-recording
content changes <1% of pixels between frames, so re-encoding the full canvas
each frame is what inflates the file. `gifenc`'s `writeFrame` has no x/y offset
parameter, which is why the current code can't do partial frames.

## Required changes
1. Inter-frame delta encoding:
   - Composite each frame to full RGBA (already done).
   - Diff against the previous composited frame; compute the bounding box of
     changed pixels. If nothing changed, extend the previous frame's delay
     instead of writing a new frame (cap to the GIF max of 65535 cs).
   - Write only the bounding-box region with `dispose: 1` (keep previous).
   - Inside the box, map pixels that are unchanged from the previous frame to
     the transparent index so LZW sees long runs. Only do this when the frame
     has no real alpha; if the frame has real transparency, fall back to the
     current full-frame path for that frame.
2. Single global palette: quantize once across all frames (sample pixels across
   frames, not just frame 0) and reuse it. Fall back to a local palette only for
   frames whose exact color count exceeds the budget AND quantization error
   against the global palette is high. Default export colors should be 256,
   not 128.
3. Encoder: `omggif` (already a dependency) `GifWriter.addFrame(x, y, w, h,
   indexed, {palette, delay, disposal, transparent})` supports offsets, global
   palette and disposal 1. Either switch the sink to omggif or write the image
   descriptor manually. Keep the `GifSink` interface unchanged so the worker
   does not need edits.
4. Keep Floyd-Steinberg dithering optional but default it OFF for the delta
   path: dithering noise differs frame to frame and defeats the unchanged-pixel
   optimization. If the user turns it on, dither against the global palette
   with a deterministic pattern so static regions stay identical.
5. Preserve existing behavior: delays rounded to centiseconds, repeat handling,
   first-frame transparency, exact-color fast path.

## Acceptance criteria
- Round trip `samples/better-rename-clean.gif` with no edits: output must be
  within 1.5x of 464 KB (target: under 600 KB) and visually identical when
  decoded frame by frame (compare composited RGBA, allow zero diff when
  dithering is off and colors = 256).
- Delete 37 frames and export: output must be smaller than the source, not larger.
- Add a vitest in `tests/` that encodes a synthetic 20-frame 400x300 animation
  where only a 20x20 square moves, and asserts the file is under 10% of what the
  full-frame encoder produced (keep the old path behind a flag for the comparison
  or hardcode the expected ceiling).
- Add a test that a frame identical to the previous one is merged into the
  previous frame's delay.
- Update the export size estimate in `src/app.ts` so it reflects the new encoder.

## Verification
Decode outputs with Pillow or gifuct-js and report per-frame: bounding box,
disposal, palette (global/local), file size. Include before/after numbers in
the summary.
