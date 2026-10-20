# Changelog

## 1.0.0 - Unreleased

First public release.

- `texenc` encodes PNG sequences and videos into ASTC texture arrays in KTX2 files for alpha-video-gpu (default block 4×4, `thorough`). Alpha is on and premultiplied by default.
- Compression: KTX2-internal zstd (default level 18) or none.
- Seek points: with zstd, a new zstd frame every `--seek-interval` MB of ASTC (default 8) and a seek table in zstd's seekable format at the end of the level, so streaming players seek by decoding at most one interval. On long clips, 8 MB intervals cost 0.8–1.6% in size. `--seek-interval 0`, and clips shorter than one interval, give one zstd stream as before. With seek points, toktx compresses at level 1 and the level is then recompressed at `--zstd`; the stream encoder compresses up to `--parallel` frames at once.
- Perceptual ASTC encoding by default, with both toktx and astcenc (the stream encoder); `--no-astc-perceptual` optimizes for RMS error instead.
- Standard KTX 2.0 metadata only: the frame rate in `KTXanimData` (a fraction, so 29.97 fps is exact), and premultiplied alpha as the data format descriptor's `KHR_DF_FLAG_ALPHA_PREMULTIPLIED` flag. Frame size, count and block size are in the header. The JSON `BasisPlayerMetadata` entry is no longer written.
- `--video` keeps the alpha of VP8 and VP9 WebM, decoding those with libvpx. ffmpeg's own decoders, used before, ignore WebM's alpha and gave opaque frames.
- `--fps` takes a whole number, a decimal or a fraction (`30`, `29.97`, `30000/1001`), and defaults to the video's own rate for `--video` input (else 30). Decimal NTSC rates are stored as their exact 1000/1001 fractions.
- The earlier UASTC, atlas, GLB and whole-file `.zst` outputs are on the `archive/basis-atlas-parts` branch.
- `texenc-stream` (also `texenc --use-stream-encoder`) encodes frame by frame with astcenc, so memory stays flat however long the input is.
  - Video input is decoded once by one ffmpeg process that pipes raw frames, read as astcenc needs them. Before, every batch of 50 frames ran ffmpeg over the whole video, so encode time grew with the square of the length: 300 frames of a 5-minute 1080p source took 45 s, and now take 7 s, with identical output.
  - Writes to zstd wait for it to drain, so a slow compression level no longer buffers the video in memory.
  - Without `--alpha`, video frames are encoded opaque. Before, a source with an alpha channel kept it, not premultiplied.
  - `texenc --use-stream-encoder` passes `--alpha` for video as it does for PNGs, so alpha video is premultiplied, as the file says.
  - Premultiplying video frames no longer needs sharp.
- `texenc doctor` lists the tools it found (toktx, astcenc, ffmpeg, ffprobe, zstd and sharp), with versions or install hints. Both encoders check for the tools a run needs before starting, and stop with an install hint when one is missing.
- astcenc is found through `--astcenc`, then `$ASTCENC`, then `PATH`, including the CPU-specific names in ARM's release zips.
- Output passes `ktx validate`: uncompressed level data starts on a 16-byte boundary, and supercompressed level data follows the metadata with no padding.
