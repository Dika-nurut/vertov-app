# Media fixture corpus — zero-spend testing harness (T2)

A small set of **synthetic** ffmpeg-generated media that stands in for real
provider output everywhere the testing harness needs predictable bytes:

- the **mock gateway** (`MockGatewayAdapter`) returns a corpus clip for a video
  `success` outcome — no provider call, no credit spend;
- the **editor render harness** (`runStudioRender`) consumes these as clip
  inputs over `file://` paths, for every instrument family (E1–E9);
- **аниматик** assembly, **раскадровка** PDF frame-fetch and the montage
  tray → Studio handoff all read real, known media.

## Provenance

Every clip is a pure ffmpeg lavfi source — `testsrc2`, `smptebars`, `sine`.
There is **no captured, scraped or provider-generated media here**, so the
corpus carries no licensing or moderation concerns and is safe to commit.

Regenerate the bytes from scratch:

```bash
bash fixtures/media-corpus/generate.sh
```

Bytes are committed and frozen — regeneration exists for reproducibility and
provenance, not to run on every test. High CRF + 32k audio keep the whole
corpus well under half a megabyte.

## Contract

`manifest.json` is the source of truth for each clip's id / dimensions / fps /
duration / audio. `apps/worker/src/test-support/corpus.test.ts` ffprobes every
file and fails if the committed bytes drift from the manifest — so downstream
tests can rely on exact dims and durations.

Every video carries a real audio track — AI video output is never truly
silent, and the editor's `loudnorm` pass stalls on pure digital silence. The
"mute a clip" editor action is exercised via `clip.muted`, not an audio-less
source; the still PNG is the only audio-less asset.

| id                | file                         | dims      | fps | dur | audio |
| ----------------- | ---------------------------- | --------- | --- | --- | ----- |
| `bars-720p`       | bars-1280x720-30fps-2s.mp4   | 1280×720  | 30  | 2s  | 220Hz |
| `testsrc-480p`    | testsrc-854x480-24fps-1s.mp4 | 854×480   | 24  | 1s  | 330Hz |
| `tone-720p-audio` | tone-1280x720-30fps-3s.mp4   | 1280×720  | 30  | 3s  | 440Hz |
| `motion-portrait` | motion-720x1280-24fps-1s.mp4 | 720×1280  | 24  | 1s  | 550Hz |
| `still-portrait`  | still-1080x1920.png          | 1080×1920 | —   | —   | —     |
