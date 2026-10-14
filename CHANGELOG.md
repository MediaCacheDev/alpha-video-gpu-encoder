# Changelog

## 1.0.0 - Unreleased

First public release.

- `texenc` encodes PNG sequences and videos into ASTC texture arrays in KTX2 files for alpha-video-gpu (default block 4×4, `thorough`). Alpha is on and premultiplied by default.
- Compression: KTX2-internal zstd (default level 18) or none.
- Perceptual ASTC encoding by default, with both toktx and astcenc (the stream encoder); `--no-astc-perceptual` optimizes for RMS error instead.
- The `BasisPlayerMetadata` key the player reads. The earlier UASTC, atlas, GLB and whole-file `.zst` outputs are on the `archive/basis-atlas-parts` branch.
- `texenc-stream` (also `texenc --use-stream-encoder`) encodes frame by frame with astcenc, so memory stays flat however long the input is.
- `texenc doctor` lists the tools it found (toktx, astcenc, ffmpeg, ffprobe, zstd and sharp), with versions or install hints.
- astcenc is found through `--astcenc`, then `$ASTCENC`, then `PATH`, including the CPU-specific names in ARM's release zips.
- Output passes `ktx validate`: uncompressed level data starts on a 16-byte boundary, and supercompressed level data follows the metadata with no padding.
