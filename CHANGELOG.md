# Changelog

All notable changes to Clip Merger are documented here.
Format follows Keep a Changelog; the project uses a SemVer-ish scheme.

## [0.9.3] - 2026-10-20

### Changed
- **Mic recorder is now a single-lane editor with the main jog bar.** The ALT lane is
  gone; the editor has one MAIN lane plus the same start / prev cut / next cut / end
  shuttle bar as the main timeline. Save writes that one take as a 48 kHz mono WAV.

### Fixed
- **Waveforms stay locked to the ruler.** A take dragged past the edge of the view used
  to be squeezed into the visible sliver, and a take longer than the view redrew an
  identical picture while the ruler scrolled — the waveform looked frozen. Peaks are now
  sampled over the visible pixels only, so one pixel is always the zoom's `1/pps`
  seconds: takes are cut off at the edge and slide under the ruler as you scroll, pan,
  jog or play.
- **Playback reads the take's source in-point.** After splitting and deleting the
  beginning, Play used to start at the head of the take ("you still hear the beginning").
  Playback now starts at the clip's `[from, to)` window, so it matches the saved WAV.
- **Dragging a take or an edge past the viewport auto-scrolls the timeline**, so you can
  keep dragging further out instead of pinning it against the edge.
- **Dragging a take's edge no longer trims the wrong side.** The pointer passed
  `left`/`right` while the model matched `l`, so every edge drag shortened the right
  edge. Edges now move the side you grabbed.
- **Edges can be dragged back out.** Takes keep the whole recorded sample buffer and
  trim a [from, to) window, so trimming is reversible — after a split you can pull an
  edge back over audio instead of losing it.
- **Waveforms are much easier to read.** Each take is normalized to its own peak
  (up to 8×) before drawing; quiet recordings fill the lane. Audio data is unchanged.
- **Space always plays/pauses in the mic editor**, even when a toolbar button still
  has focus; **R** now toggles recording.

### Added
- **Double-click to delete or close gaps.** Double-click a take to delete it, or a gap
  to ripple later takes left and close it.

### Removed
- Shift+wheel panning; pan by dragging with the middle mouse button, like the main
  timeline.

## [0.9.2] - 2026-10-20

### Changed
- **Mic recorder rebuilt as a compact audio timeline.** It now has a ruler, MAIN/ALT
  lanes, zoom/Fit, snapping, split/delete, undo/redo and the main timeline's shortcuts
  (Space, S, Del, Ctrl+Z/Y, A/D, F, Ctrl+wheel), and it draws the live waveform while
  recording. Save still mixes both tracks into one 48 kHz mono WAV.

## [0.9.1] - 2026-10-20

### Fixed
- **Images and freeze frames play back correctly.** Stills now advance the playhead
  across their span and hand off to the next clip (video, image or freeze) instead of
  freezing on screen — this also fixes the Play button appearing stuck when playback
  started on a still or reached one mid-timeline.
- **The Freeze action moved into the Effects bin.** It is now a **Freeze** tile you
  click to insert a 3-second still at the playhead; the temporary **R** shortcut was
  removed.
- Stale selection ids can no longer crash the toolbar edge lookup.

### Changed
- **Mic recorder is now a two-track editor (MAIN / ALT).** Record punches into the
  active track at the playhead; drag takes to move them, drag their edges to trim,
  split and delete them, then Save mixes both tracks into one WAV. The toolbar **Mic**
  button is red and the record button shows a round red record dot.

## [0.9.0] - 2026-10-19

### Added
- **Mic recording.** The **Mic** button opens a recorder that captures the default
  microphone as 48 kHz mono WAV. It draws a live waveform, supports punch-in recording
  from the mini-timeline playhead, and trims both ends before saving. Takes land in the
  Sounds bin under **Mic Record**; they are not added to the timeline automatically.
- **Favorites for every bin.** Right-click a Media/Images, Sound, Transition or Effect
  item to rate it 1–5 stars, clear the rating, or reveal it in Explorer. Favorites sort
  above unstarred items (most stars first, then name) and persist per path in
  `userData/library.json`; built-in effects are keyed by effect id.
- **Images on the timeline.** The Media bin accepts PNG/JPG/JPEG/WebP/GIF/BMP, and an
  `IMAGES` folder is pinned to the top of the bin. Stills add as 3-second clips on MAIN
  or ALT, can be trimmed longer, take zoom/pan/shake effects, show real thumbnails and
  previews, and export as looping stills.
- **Freeze frame.** Put the playhead over a video clip and press **Freeze** (or **R**)
  to split the clip if needed and insert a 3-second freeze, rippling every lane and
  marker to the right. Freezes trim like clips, take camera effects, use an ice-block
  look, and export a frame regenerated from the source at that timestamp.
- Project format is now **v7** with explicit `video` / `image` / `freeze` kinds; older
  projects load as video clips.

### Fixed
- **Bin thumbnails work again.** Thumbnail temp files now keep a `.jpg` suffix, so
  ffmpeg can infer the output format instead of failing before the image is written.
- **Exports can no longer overwrite a source clip.** The save dialog rejects any
  path used by the timeline, ALT or sound lanes, and the export pipeline repeats
  the check as a second line of defense.
- **Project saves are atomic and failures are surfaced.** Saves write to a
  sibling temp file and rename it into place; a failed write keeps the previous
  project and leaves the unsaved-changes prompt usable instead of disabling its
  Save button.
- **Quitting during an export cancels ffmpeg and waits for cleanup.** Closing the
  window now asks before cancelling an active render, kills its child processes,
  and lets the temp work folder finish before the app exits.
- **Keyframe caches invalidate when a source file changes.** Cache entries are
  keyed by path plus timestamps and size, and the renderer clears its tick-mark
  cache on bin refreshes, so replacing a file in place cannot make export treat
  a non-keyframe cut as lossless.
- **Lossless export is no longer disabled by the default blur framing.** When a
  source already matches the output size/FPS, the blurred background is fully
  covered and invisible, so keyframe-aligned cuts now stream-copy instead of
  needlessly re-encoding. Blur still forces a re-encode when scaling is needed.
- **Undo/redo restores camera effects.** Effects are captured in every history
  snapshot and now restored with the other lanes, so undo/redo no longer leaves
  added or edited effect bands behind.
- **Clips starting before 0:00 export at the right time.** A clip parked in the
  editing pre-roll is trimmed to the 0:00 boundary (skipping the hidden source
  seconds) instead of shifting the rest of the edit later.

## [0.8.1] - 2026-10-18

### Fixed
- **Zoom/Shake now play smoothly in the preview.** During playback the pose was
  sampled from `state.playhead`, which the browser only advances on `timeupdate`
  (~4×/second) — so the effect animated in ~4 steps/sec while the video played
  normally. The preview now derives the pose from the active video's live
  `currentTime` (per frame), matching scrubbing and the export. Fixes both
  zoom-in/out and shake playback.

## [0.8.0] - 2026-10-18

### Changed
- **One Shake effect** (the Strong / Very Strong preset tiles are gone). Its
  **Intensity** is now adjustable: a 1–15% slider plus a matching number input,
  default 4%.
- **Per-effect tools.** The FX toolbar group shows the tools for the selected
  effect's type — zoom (pose, Smooth/Linear, Black/Blur) or shake (Intensity) —
  and hides the other. Adjusted intensity previews live and parks the playhead
  inside the shake band so you can see the result; changes are undoable.

## [0.7.1] - 2026-10-18

### Fixed
- **Adding an item now deselects everything else and selects only the new
  item(s).** Previously the old selection stayed, and dropping an effect added to
  the selection without clearing others (so a clip and the effect were both
  selected). Applies to drag-drop, double-click append, the bin ＋ button, OS file
  drops and paste.

## [0.7.0] - 2026-10-18

### Changed
- **Header grouped:** New / Open / Save are one bordered group (like the layout
  segmented control); Settings / Help are one group on the right.
- **Contextual timeline toolbar.** Tools now live in groups that show only when
  relevant: `basic` (Play/Pause, Split, Delete, Marker) and `view` (Hide FX, Snap,
  Fit) always; `clip` (Detach, Speed, Frame) when a clip/transition is selected;
  `audio` (Vol) for clips or sounds; `fx` (pose, Smooth/Linear, Black/Blur) when an
  effect is selected. Mixed selections show the union; group dividers are borders
  so hiding a group also removes its separator.

## [0.6.1] - 2026-10-18

### Fixed
- **Notifications are visible now.** `#toasts`/`.toast` had no styling, so toasts
  rendered as plain text at the bottom of the window. They are now floating cards
  stacked bottom‑right (warn/danger variants, slide/fade in, click to dismiss).
- **Unsaved reminder persists** until you save or click it; if you dismiss it while
  still dirty it reminds again 10 minutes later. Saving (or returning to the saved
  state) removes it.
- **Save button age colours** (`age-green/yellow/orange/red`) are now styled, plus a
  dirty dot and a tooltip ("Unsaved changes — last saved N min ago").

## [0.6.0] - 2026-10-18

### Added
- **Resizable bins (horizontal).** Drag the vertical dividers between Media /
  Transitions / Sounds / Effects to widen a tab and squeeze its neighbours
  (portrait), or the side columns vs the viewer (landscape). Widths persist per
  layout in `localStorage`. No vertical resizing.

### Changed
- **Effects bin** now flows in **auto-fill columns** (2+ across) like the other
  bins.
- **Sounds** are **compact rows** (name + duration) with no media-thumbnail
  window.

## [0.5.6] - 2026-10-18

### Changed
- **A/D works the same for every selected item now** (media clip, transition,
  sound, ALT clip/sound, effect): **A → its start**, **D → its end** (staying
  selected), and pressing the key for the edge you're already on switches to
  **global** cut jumping **and deselects**. Previously only effects did this;
  other items used nearest-edge.
- The **A/D edges/global hint** now shows for any single selected item and moved to
  a neutral spot next to the time readout (was inside the FX controls).

## [0.5.5] - 2026-10-18

### Changed
- **A/D effect navigation simplified to positional + deselect-on-global.** With an
  effect selected, **A → its start** and **D → its end** (staying selected), so you
  can toggle Start↔End to edit either pose. Pressing the key for the edge you're
  **already on** (A at start, D at end) switches to **global** cut jumping **and
  deselects** — removing the earlier "bounce." Global jumps always deselect.
- Removed the per-direction one-shot (`effectNav`) machinery.

## [0.5.4] - 2026-10-18

### Fixed
- **A/D with an effect selected is now a one-shot per direction.** The previous
  rule was positional, so after the global jump moved the playhead off the edge,
  the next press snapped **back** to the effect's end (a "bounce"). Now: first D
  goes to the effect's end (first A to its start), and further presses in that
  direction go to the global cuts — no bounce.
- Re-arms (edge mode) when you select/click an effect or move the playhead yourself.

### Added
- A small toolbar hint by the FX controls shows what A/D will do for the selected
  effect — **"A/D: edges"** (armed) vs **"A/D: global"** (served).

## [0.5.3] - 2026-10-18

### Changed
- **A/D with an effect selected** now goes to that effect's own **end** (D) or
  **start** (A) on the first press, and switches the pose editor to that edge; the
  next press falls through to global navigation.
- **Global A/D no longer changes the selection** — it previously auto-selected the
  effect whose edge it landed on, which made the start of back-to-back effects
  unreachable. (Global still stops at effect edges; clips/sounds keep nearest-edge
  behavior.)

## [0.5.2] - 2026-10-18

### Added
- **A/D on an effect edge** selects that effect, switches the pose editor to its
  Start/End pose, and the preview shows that end pose while the playhead stays
  exactly on the cut (display-only clamp; export unaffected).
- **Zoom pose linking** — when an effect's end snaps to another zoom effect's
  start, the later effect's Start pose is copied from the earlier effect's End
  pose (continuous zoom-in → zoom-out, no camera jump).

### Fixed
- **Effect drag ghost** — effect tiles now show the floating drag card, and the
  on-timeline ghost follows the pointer (it no longer jumps to a clip edge while
  the drop lands at the pointer).

## [0.5.1] - 2026-10-18

### Added
- **F** hotkey = **Fit** the timeline to the window (also listed in Help & shortcuts;
  the Fit button tooltip shows it).

### Removed
- Dead/unreachable hold-to-scrub A/D block in the keydown handler (the earlier A/D
  jump-to-cut handling always returned first).

## [0.5.0] - 2026-10-18

### Added
- **Shake effects** in the Effects panel, tuned as presets — **Shake** (1.2% @15 Hz),
  **Strong Shake** (3% @20 Hz), **Very Strong Shake** (6% @26 Hz). Drop on a video
  lane and drag/extend the band over the moment to shake. Bounded to the band, and
  **stacks with zoom** (e.g. zoom-in + shake).
- Deterministic sum-of-sines jitter (absolute time) so the **preview and export
  match**; a small overscan zoom keeps the shaken frame covering (no black edges).
- **Effect snapping** — effect start/end are snap points, and effect move/trim snap
  to clips, sounds, markers, the playhead and **each other** (yellow guide).

## [0.4.0] - 2026-10-18

### Added
- **Effects (adjustment layers).** A new **Effects** panel with draggable tiles
  (**Zoom In**, **Zoom Out**). Drop one on a MAIN/ALT lane to create a **purple
  effect band** you can **push, extend left/right, delete, and undo** like any
  item. Effects span freely and **can cross cuts**.
- Each effect animates a **camera pose** over its band — **zoom *and* pan
  together**. Overview (`from`) and zoomed (`to`) poses are set on the preview:
  pick **Start/End pose** in the toolbar, **scroll** to set that pose's zoom and
  **drag** to pan it (1:1, image-editor feel). **Smooth/Linear** easing and a
  **Black/Blur** background for zooms below 100%.
- **FX toggle** hides the bands so you can click the clips behind them.
- Export applies the camera move per clip segment (mapping absolute effect time
  to each segment), so one effect drives a smooth move **across a cut**; gaps,
  MAIN-over-ALT priority and black padding are preserved. (Validated on ffmpeg 8.1.)

### Fixed
- **Export now includes effects** — the export payload was missing the `effects`
  array, so exported files had no zoom/pan at all.
- **Effects are bounded to their band** — outside the band the frame is normal
  (they previously held the last pose across later clips).
- **Double-click the preview** resets the pose being edited (Start or End) to the
  whole frame / no zoom.
- **A/D** now snaps to the selected item's own start/end first, then falls back to
  the global previous/next cut; effect start/end are included as cut points.

### Changed
- **Replaced the per-clip zoom** with the effect-layer system above.
- Project format bumped to **v6** (`effects` array); older projects load unchanged.

## [0.3.0] - 2026-10-18

### Added
- **Video Zoom effect** on any clip (MAIN or ALT):
  - **Scroll over the preview** to set the zoom level (25%–400%).
  - **Drag on the preview** for true **1:1 panning** (image-editor feel) — the
    source point you centre is held at the frame centre.
  - A timeline **band with start/end handles** times the zoom — the band length
    is the speed. **Zoom in** (1→level, holds) and **Zoom out** (level→1).
  - **Smooth** (eased) or **Linear** easing.
  - Per-clip **Black / Blur** background for zooms below 100%.
  - **Smooth preview** (per-frame `requestVideoFrameCallback`/rAF, not the ~4 Hz
    `timeupdate`) and an export whose framing **matches the preview exactly**
    (centre-point overlay maths). (Validated against ffmpeg 8.1.)
- `TimelineOps.zoomFactor` (shared zoom maths) and `export.zoomScaleExpr`
  (ffmpeg expression builder), both unit-tested.

## [0.2.0] - 2026-10-18

### Added
- **ALT (CLIPS2) track parity** with MAIN: auto-arrange, gap blocks, mute badge,
  keyframe ticks + prefetch, sound trim handles, and Speed / Detach on ALT clips.
- **Detach audio from ALT** goes to the SOUND lane (source clip muted).
- **Overlap handling**: same-lane overlaps highlight the *shorter* item in red
  (raised so it can be selected); a status warning shows and **Export is blocked**
  until they are resolved.
- **Priority playback/export**: the visible video is MAIN where it has a clip and
  ALT where MAIN has a gap; audio mixes from all tracks (SOUND + ALT sounds).
- **Cut navigation spans every track** — next/prev cut stops on MAIN, ALT, and
  SOUND edges.
- **Double-click deletes** a clip/ALT item/sound, and **double-click closes a gap**
  (detected on pointerdown, so it survives the lane re-render).
- **Gap-preserving export**: video gaps are padded with black + silence so output
  time equals timeline time and sound positions line up with the editor.

### Changed
- Manual moves no longer auto-arrange — overlaps persist so they can be seen and
  fixed by hand (export stays blocked while any overlap exists).
- Play from a mid-timeline gap now seeks the **next** clip instead of the first.

### Fixed
- Fatal syntax error in the renderer that stopped the app from parsing.
- Removed dead `itemByTime` code.

## [0.1.0] - 2026-10-06

### Added
- Initial release: 3 bins (Media / Transitions / Sounds), timeline with move /
  trim / split / snap, playhead + markers, per-clip Mute / Detach / volume,
  waveforms + beat detection, custom scrollbar + hand tool, lossless-first
  export (AMF / NVENC / libx264), project save/open, persisted settings.
