# Changelog

## 1.0.0 - Unreleased

First public release.

- `texenc` encodes PNG sequences and videos into KTX2 texture arrays for alpha-video-gpu: native ASTC (default 4×4, `thorough`), Basis Universal UASTC, or uncompressed ASTC. Alpha is on and premultiplied by default.
- Compression: KTX2-internal zstd (default level 18), a whole-file zstd wrapper, or none.
- Atlas output, and the `BasisPlayerMetadata` key the player reads.
- `texenc-stream` (also `texenc --use-stream-encoder`) encodes frame by frame with astcenc, so memory stays flat however long the input is.
- `texenc doctor` lists the tools it found (toktx, astcenc, ffmpeg, ffprobe, zstd and sharp), with versions or install hints.
- astcenc is found through `--astcenc`, then `$ASTCENC`, then `PATH`, including the CPU-specific names in ARM's release zips.
- Output passes `ktx validate`: uncompressed level data starts on a 16-byte boundary, and supercompressed level data follows the metadata with no padding.
