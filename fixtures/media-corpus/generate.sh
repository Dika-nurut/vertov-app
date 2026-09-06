#!/usr/bin/env bash
# Deterministic fixture media corpus for the zero-spend testing harness (T2).
#
# These are the REAL render inputs every downstream consumer sees offline:
#   • the mock gateway (video success → a corpus clip, base64-inlined)
#   • the editor render harness (runStudioRender over file:// paths)
#   • аниматик assembly / раскадровка frame-fetch / montage tray → Studio
#
# All clips are synthetic ffmpeg sources (testsrc2 / smptebars / sine) — no
# provider call, no copyrighted media, tiny enough to live in-repo. Properties
# (duration / resolution / fps / audio) are KNOWN and asserted by
# corpus.test.ts, so a downstream test can rely on exact dims & durations.
#
# Regenerate:  bash fixtures/media-corpus/generate.sh
# Bytes are committed; regeneration is for provenance/reproducibility, not per-run.
set -euo pipefail
cd "$(dirname "$0")"

# bitexact keeps encodes as reproducible as x264 allows; high CRF + low audio
# bitrate keep every clip tiny (test corpus — properties matter, not fidelity).
COMMON=(-y -hide_banner -loglevel error -fflags +bitexact -flags:v +bitexact -flags:a +bitexact)
X264=(-c:v libx264 -preset veryfast -crf 40 -pix_fmt yuv420p)

# Every video carries a real audio track. AI video output (seedance/etc.) is
# never truly silent, and the editor's loudnorm pass stalls on pure digital
# silence — so a low-level tone keeps the corpus faithful AND renderable. The
# "mute a clip" editor action is exercised via clip.muted, not a no-audio
# source. The still PNG remains the only audio-less asset.
AUD=(-c:a aac -b:a 32k -shortest)

echo "→ bars-1280x720-30fps-2s.mp4 (smptebars + quiet 220Hz tone)"
ffmpeg "${COMMON[@]}" -f lavfi -i "smptebars=size=1280x720:rate=30:duration=2" \
  -f lavfi -i "sine=frequency=220:duration=2:sample_rate=44100" \
  "${X264[@]}" -g 30 "${AUD[@]}" bars-1280x720-30fps-2s.mp4

echo "→ testsrc-854x480-24fps-1s.mp4 (motion + 330Hz tone)"
ffmpeg "${COMMON[@]}" -f lavfi -i "testsrc2=size=854x480:rate=24:duration=1" \
  -f lavfi -i "sine=frequency=330:duration=1:sample_rate=44100" \
  "${X264[@]}" -g 24 "${AUD[@]}" testsrc-854x480-24fps-1s.mp4

echo "→ tone-1280x720-30fps-3s.mp4 (motion + 440Hz audio)"
ffmpeg "${COMMON[@]}" \
  -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=3" \
  -f lavfi -i "sine=frequency=440:duration=3:sample_rate=44100" \
  "${X264[@]}" -g 30 "${AUD[@]}" tone-1280x720-30fps-3s.mp4

echo "→ motion-720x1280-24fps-1s.mp4 (portrait 9:16 motion + 550Hz tone)"
ffmpeg "${COMMON[@]}" -f lavfi -i "testsrc2=size=720x1280:rate=24:duration=1" \
  -f lavfi -i "sine=frequency=550:duration=1:sample_rate=44100" \
  "${X264[@]}" -g 24 "${AUD[@]}" motion-720x1280-24fps-1s.mp4

echo "→ still-1080x1920.png (portrait still)"
ffmpeg "${COMMON[@]}" -f lavfi -i "smptebars=size=1080x1920:rate=1:duration=0.1" \
  -frames:v 1 still-1080x1920.png

echo "✓ corpus generated"
