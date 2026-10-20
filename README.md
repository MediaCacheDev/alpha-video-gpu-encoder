# alpha-video-gpu-encoder

Encodes video files and image sequences into ASTC texture arrays in KTX2 files for [alpha-video-gpu](https://github.com/MediaCacheDev/alpha-video-gpu).

## What It Does

1. **Extracts frames** from video files (MP4, MOV, etc.) or reads PNG sequences
2. **Encodes to ASTC** using `toktx` (KTX-Software) or `astcenc` (ARM)
3. **Packs into KTX2** texture arrays with optional zstd supercompression
4. **Records the frame rate** in KTX2's standard `KTXanimData` key, and marks the alpha as premultiplied
5. **Supports streaming** - constant memory playback regardless of video length

## Terminology

| Term | Full Name | Description |
|------|-----------|-------------|
| **KTX2** | Khronos Texture 2.0 | Container format for GPU-compressed textures. Stores texture data with metadata, supports mipmaps, texture arrays, and internal compression. Think of it as "MP4 for textures". |
| **ASTC** | Adaptive Scalable Texture Compression | GPU texture compression format developed by ARM. Supported natively on all modern mobile GPUs (iOS, Android) and Apple Silicon Macs. Offers configurable quality/size tradeoff via block sizes (4x4 to 12x12). |
| **Zstd** | Zstandard | Fast lossless compression algorithm by Facebook. Used to compress ASTC data for smaller file sizes. Decompresses at ~1GB/s on modern hardware. |
| **Texture Array** | 2D Texture Array | GPU feature that stores multiple 2D images as layers in a single texture. Each video frame is one layer. More efficient than individual textures. |
| **astcenc** | ASTC Encoder | ARM's official ASTC compression tool. Used by the stream encoder for memory-efficient encoding. |
| **toktx** | To KTX | KTX-Software's tool for creating KTX2 files. Used for the default ASTC encode. |
| **Premultiplied Alpha** | - | Alpha blending technique where RGB values are pre-multiplied by alpha. Prevents dark "halo" artifacts around transparent edges. This encoder always premultiplies when alpha is enabled. |

### ASTC Block Sizes

ASTC divides images into fixed-size blocks and compresses each block to exactly **128 bits (16 bytes)**. Larger blocks = more pixels per 16 bytes = smaller files but lower quality.

| Block | Pixels | Bits/Pixel | File Size | Quality |
|-------|--------|------------|-----------|---------|
| **4x4** | 16 | 8.00 bpp | 100% (baseline) | Highest - preserves fine detail |
| **5x5** | 25 | 5.12 bpp | ~64% | Excellent |
| **6x6** | 36 | 3.56 bpp | ~44% | Great - recommended for most content |
| **8x8** | 64 | 2.00 bpp | ~25% | Good - minor artifacts on sharp edges |
| **10x10** | 100 | 1.28 bpp | ~16% | Acceptable - visible on detailed content |
| **12x12** | 144 | 0.89 bpp | ~11% | Low - only for simple graphics |

**How it works:** ASTC is adaptive - it analyzes each block and chooses the best encoding strategy. For smooth gradients (common in UI video and effects), larger blocks work well because there's less high-frequency detail to preserve. For sharp edges or fine text, smaller blocks are needed.

**Recommendation:** Start with **6x6** for video with alpha. It offers ~56% file size reduction with virtually no visible quality loss for most use cases. Drop to **8x8** for even smaller files if quality is acceptable. Use **4x4** (the default) when you need maximum quality for detailed content.

## ASTC or a Video Codec?

ASTC makes a different trade-off from VP9 and AV1. A video codec spends CPU on every frame to make the file as small as possible. ASTC is a format the GPU samples directly, so playback needs almost no CPU and leaves it free for the rest of the UI, even with many animations on screen. The cost is file size.

```
VP9 / AV1:  file → decode on the CPU → YUV → convert to RGBA → upload → draw
ASTC:       file → zstd (or nothing) → upload as is → draw (the GPU decodes while sampling)
```

### Size and quality

Two clips, decoded from the demo app's WebM files to PNG and encoded from those PNGs into each format. VP9 is a single stream with alpha (`libvpx-vp9 -crf <n> -b:v 0 -speed 0 -auto-alt-ref 0`, yuva420p). AV1 is two streams, colour and alpha (`libsvtav1 -crf <n> -preset 8`). ASTC is `texenc` with its defaults (`thorough`, perceptual, zstd 18) at each block size. PSNR is measured against the source over premultiplied RGBA, every frame. The sources are VP9 decodes, which may favour the VP9 re-encodes slightly.

**Glow:** 400×400, 181 frames, 30 fps, mostly transparent.

| Format | Size | PSNR |
|--------|-----:|-----:|
| VP9, CRF 18 | 1.0 MB | 50.9 dB |
| VP9, CRF 30 | 0.56 MB | 48.4 dB |
| AV1, CRF 28 | 0.60 MB | 48.8 dB |
| AV1, CRF 35 | 0.37 MB | 47.2 dB |
| ASTC 4x4 | 5.5 MB | 53.0 dB |
| ASTC 5x5 | 3.6 MB | 50.4 dB |
| ASTC 6x6 | 2.5 MB | 49.1 dB |
| ASTC 8x8 | 1.4 MB | 46.3 dB |

**Manta:** 1920×1080, 424 frames, 29.97 fps, mostly opaque moving footage.

| Format | Size | PSNR |
|--------|-----:|-----:|
| VP9, CRF 18 | 7.0 MB | 49.7 dB |
| VP9, CRF 30 | 4.7 MB | 48.8 dB |
| AV1, CRF 28 | 6.4 MB | 46.0 dB |
| AV1, CRF 35 | 3.7 MB | 44.5 dB |
| ASTC 4x4 | 95 MB | 59.2 dB |
| ASTC 5x5 | 85 MB | 55.2 dB |
| ASTC 6x6 | 63 MB | 52.8 dB |
| ASTC 8x8 | 38 MB | 49.2 dB |

At similar quality, ASTC is about 4 times the size of VP9 for the glow (5x5 against CRF 18, 6x6 against CRF 30), and about 5.5 times for the manta (8x8 against CRF 18). Zstd shrinks transparent areas well, while video codecs gain most on detailed footage that moves, by predicting each frame from the previous ones. Every ASTC frame is stored on its own, which is also why any frame can be shown directly.

### Playback

The [alpha-video-gpu README](https://github.com/MediaCacheDev/alpha-video-gpu#on-a-budget-android-phone) has measurements on a budget Android phone (a Samsung Galaxy A52s). In short: one 1080p clip kept 3 to 4 cores busy as VP9 or AV1 and under one as ASTC, and 20 glow players saturated all 8 cores as VP9 but used about 2.5 as uncompressed ASTC; 50 still ran with 3.7.

On the CPU of an M4 Pro, decoding one frame took (one thread):

| Clip | VP9 (libvpx) | AV1, both streams (dav1d) | ASTC (zstd only) |
|------|-------------:|--------------------------:|-----------------:|
| Glow, 400×400 | 0.4–0.6 ms | 0.5–0.6 ms | 0.03–0.06 ms |
| Manta, 1080p | 2.4–2.7 ms | 2.6–2.9 ms | 0.2–0.7 ms |

Video then still needs converting from YUV to RGBA before the GPU can draw it. Files encoded with `--zstd 0` skip even the zstd step.

### When to use each

| Use case | Choose |
|----------|--------|
| Many animations on screen at once, UI effects, stickers, glows | ASTC |
| Keeping the CPU free for the app, or the battery | ASTC |
| Frame-exact seeking and scrubbing | ASTC |
| Long or high-resolution footage, especially opaque | Video |
| Download size or app size comes first | Video |

## Compression Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **Inner zstd** (default) | KTX2 internal supercompression | Single `.ktx2` file, streaming playback |
| **Uncompressed** | No compression (`--zstd 0`) | Direct mmap, fastest load |

### Seek points

A streaming player decodes zstd from where it is to where it needs to be, so with one zstd stream a seek decodes everything before its target: about 1.5 s on an M4 Pro to reach the end of a 5-minute 360p clip, and 2.9 s for 60 s of 1080p. With `--zstd` above 0, the encoder therefore starts a new zstd frame every `--seek-interval` MB of ASTC (default 8) and appends a seek table, in zstd's [seekable format](https://github.com/facebook/zstd/tree/dev/contrib/seekable_format), as the level's last bytes. The player starts decoding at the frame before its target, so no seek decodes more than one interval (about 6 ms for 8 MB).

The cost is size: zstd can't refer back past a frame start. On long clips, 8 MB intervals added 0.8% (360p, 5 min) and 1.6% (1080p, 60 s), and 32 MB intervals 0.2% and 0.4%. Clips with less ASTC than one interval come out as one stream, exactly as without seek points. `--seek-interval 0` always writes one stream, the smallest file, for clips that only play and loop.

Both layouts are ordinary KTX2 zstd data. Any zstd decoder reads the frames as one stream and skips the table, so players and tools that don't know about seek points play these files from the start as before.

## Installation

```bash
npm install -g alpha-video-gpu-encoder
```

This installs two commands: `texenc` (the main CLI) and `texenc-stream` (the memory-efficient backend, also usable on its own). Node.js 18 or newer is required.

### Prerequisites

The encoder runs external tools. Install the ones your workflow needs:

| Tool | Needed for | Tested with |
|------|-----------|-------------|
| `toktx` (KTX-Software) | The default encoder (without `--use-stream-encoder`) | 4.4.2 |
| `astcenc` (ARM) | `--use-stream-encoder` and `texenc-stream` | 5.7.0 |
| `ffmpeg` and `ffprobe` (5.1 or newer) | `--video` input, and detecting frame sizes | 8.0 |
| `zstd` | `--zstd` above 0 with the stream encoder, and seek points (clips over `--seek-interval`) | 1.5.7 |

Neither `toktx` nor `astcenc` is in Homebrew, so the commands below take both from their projects' GitHub releases.

#### macOS

```bash
brew install ffmpeg zstd

# toktx: KTX-Software's installer puts it in /usr/local/bin (Intel Macs: the Darwin-x86_64 package)
curl -LO https://github.com/KhronosGroup/KTX-Software/releases/download/v4.4.2/KTX-Software-4.4.2-Darwin-arm64.pkg
sudo installer -pkg KTX-Software-4.4.2-Darwin-arm64.pkg -target /

# astcenc: a universal binary in astcenc-sdk/bin/astcenc
curl -L https://github.com/ARM-software/astc-encoder/releases/download/5.7.0/astcenc-5.7.0-macos-universal.zip -o astcenc.zip
unzip astcenc.zip -d astcenc-sdk
```

#### Linux

```bash
sudo apt install ffmpeg zstd    # Ubuntu 24.04 or Debian 12 and newer ship ffmpeg 5.1 or newer

# toktx (arm64: the Linux-arm64 package; Fedora: the .rpm; elsewhere: the .tar.bz2)
curl -LO https://github.com/KhronosGroup/KTX-Software/releases/download/v4.4.2/KTX-Software-4.4.2-Linux-x86_64.deb
sudo apt install ./KTX-Software-4.4.2-Linux-x86_64.deb

# astcenc (arm64: astcenc-5.7.0-linux-arm64.zip)
curl -L https://github.com/ARM-software/astc-encoder/releases/download/5.7.0/astcenc-5.7.0-linux-x64.zip -o astcenc.zip
unzip astcenc.zip -d astcenc-sdk
```

Older distributions ship an ffmpeg older than 5.1 (Ubuntu 22.04 has 4.4); use a build from [ffmpeg.org/download](https://ffmpeg.org/download.html) instead.

#### Finding astcenc

ARM's zips name the binary after the instruction set it was built for: `astcenc` (macOS universal), `astcenc-avx2`, `-sse4.1` and `-sse2` (Linux x64), and `astcenc-neon` (Linux arm64). The encoders look for astcenc in this order: `--astcenc <path>`, the `ASTCENC` environment variable, then the first of `astcenc`, `astcenc-native`, `-neon`, `-avx2`, `-sse4.1` and `-sse2` found on `PATH`. Either add `astcenc-sdk/bin` to `PATH` or point at the binary:

```bash
export PATH="$PWD/astcenc-sdk/bin:$PATH"
# or
export ASTCENC="$PWD/astcenc-sdk/bin/astcenc"        # macOS
export ASTCENC="$PWD/astcenc-sdk/bin/astcenc-avx2"   # Linux x64
```

#### Windows

Untested. The same releases have Windows builds: KTX-Software's `.exe` installer and astcenc's `windows-x64` zip, alongside ffmpeg and zstd for Windows.

### Checking the setup

```bash
texenc doctor
```

lists each tool with its version or an install hint, and what it is needed for. It exits with status 1 when `toktx` or `sharp` is missing, since every default encode needs them. `--toktx <path>` and `--astcenc <path>` check specific binaries.

## Usage

### Recipes

| Goal | Encode | Play with |
|------|--------|-----------|
| Short UI video in an app | `texenc -i ./frames -o video.ktx2` | the defaults (all frames loaded) |
| Long video, constant memory | `texenc -i ./frames -o video.ktx2` | `stream` |
| Many players on screen, lowest CPU | `texenc -i ./frames -o video.ktx2 --zstd 0` | `stream` (memory-mapped, no decompression) |
| Smaller file, softer detail | `texenc -i ./frames -o video.ktx2 --astc-block 6x6` | the defaults |
| Opaque content | `texenc -i ./frames -o video.ktx2 --no-alpha` | the defaults |
| Long or large video, little RAM | `texenc -v in.mp4 -o video.ktx2 --frame-count 900 --use-stream-encoder` | `stream` |

"Play with" names the `alpha-video-gpu` props; see its README for the memory options.

### Basic Usage (Recommended)

Simplest command - auto-detects dimensions, uses sensible defaults (texture array, ASTC 4x4, `thorough` quality, perceptual, inner zstd 18, alpha on):

```bash
# From PNG frames (30 fps unless --fps says otherwise)
texenc --input ./frames --output output.ktx2

# From video (the video's frame rate unless --fps says otherwise)
texenc --video input.mp4 --output output.ktx2 --frame-count 300

# NTSC rates: 29.97 is read as 30000/1001, or give the fraction
texenc --input ./frames --output output.ktx2 --fps 30000/1001
```

### With Alpha Channel

Alpha is enabled by default. Use `--no-alpha` for opaque content:

```bash
# With alpha (default) - premultiplies automatically
texenc --input ./frames --output output.ktx2 --fps 30

# Without alpha (smaller file for opaque content)
texenc --input ./frames --output output.ktx2 --fps 30 --no-alpha
```

## Parameters

### Input / Output

| Parameter | Description |
|-----------|-------------|
| `-i, --input <dir>` | Input directory containing PNG frames (use `--input` or `--video`) |
| `-v, --video <file>` | Input video file; frames are extracted with ffmpeg |
| `--frame-count <num>` | Number of frames to extract (required with `--video`) |
| `-o, --output <path>` | **Required.** Output path; the file is written as `.ktx2` |

### Frame Options

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-w, --width <px>` | auto | Frame width (auto-detected from input) |
| `-h, --height <px>` | auto | Frame height (auto-detected from input) |
| `-f, --fps <rate>` | the video's, else 30 | Playback frame rate: a whole number, a decimal or a fraction (`30`, `29.97`, `30000/1001`). 23.976, 29.97 and 59.94 are stored as their exact NTSC fractions |

### ASTC Options

| Parameter | Default | Range/Values | Description |
|-----------|---------|--------------|-------------|
| `--astc-quality <level>` | thorough | fastest, fast, medium, thorough, exhaustive | Encoding quality level |
| `--astc-block <size>` | 4x4 | 4x4, 5x4, 5x5, 6x5, 6x6, 8x5, 8x6, 8x8, 10x5, 10x6, 10x8, 10x10, 12x10, 12x12 | Block size (smaller = higher quality, larger file) |
| `--no-astc-perceptual` | perceptual on | flag | Optimize for RMS error instead of perceived quality (toktx `--astc_perceptual`, astcenc `-perceptual`) |
| `--zstd <level>` | 18 | 0-22 | KTX2 internal Zstandard supercompression level (higher = smaller, slower; 0 = uncompressed) |
| `--seek-interval <MB>` | 8 | 0 or more, decimals allowed | With zstd, a seek point every that many MB of ASTC (see [Seek points](#seek-points)); 0 = one zstd stream |

### Other Options

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--no-alpha` | off | Disable alpha channel (for opaque content) |
| `--use-stream-encoder` | off | Use the memory-efficient stream encoder (requires `astcenc`) |
| `--astcenc <path>` | `$ASTCENC`, then `astcenc` on `PATH` | astcenc binary for the stream encoder |
| `--toktx <path>` | toktx | Path to toktx binary |
| `-y, --yes` | off | Non-interactive mode (skip prompts, for scripts) |

## Output Format

A single `.ktx2` file holding an ASTC texture array, one frame per layer. Everything a player needs is in standard KTX 2.0 fields, so `ktx info` and other KTX tools read it too:

| What | Where in the file |
|------|-------------------|
| Frame width and height | Header: `pixelWidth`, `pixelHeight` |
| Frame count | Header: `layerCount` (one layer per frame) |
| ASTC block size and colour space | Header: `vkFormat` (for example `VK_FORMAT_ASTC_4x4_SRGB_BLOCK`) |
| Frame rate | Key/value data: [`KTXanimData`](https://registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html#_ktxanimdata), the time per frame as a fraction (1/30 s, or 1001/30000 s for 29.97 fps) |
| Premultiplied alpha | Data format descriptor: the `KHR_DF_FLAG_ALPHA_PREMULTIPLIED` flag |
| Encoder | Key/value data: `KTXwriter` |

`KTXanimData` also holds a loop count, which the encoder writes as 0 (loop forever); players loop according to their own `loop` setting. Files without `KTXanimData` play at 30 fps.

Earlier versions wrote a JSON `BasisPlayerMetadata` entry instead. Everything in it is now read from the fields above, so it's no longer written. Current players don't read it, so older files play at 30 fps; encode them again to keep another rate.

## Memory-Efficient Stream Encoder

The `--use-stream-encoder` option enables a memory-efficient encoder that processes frames one at a time instead of loading everything into RAM. Essential for long videos or high-resolution content.

**The encoder will automatically recommend the stream encoder for large encodes (>200 frames or >1080p).**

### Usage

```bash
# Via the main CLI (PNG or video input)
texenc --input ./frames --output output.ktx2 --fps 30 --use-stream-encoder

# Or directly
texenc-stream --input ./frames --output output.ktx2 --zstd 18 --alpha
```

### Performance Comparison

Benchmarked on Apple Silicon (M-series) with 100 frames at 1920×1080:

| Method | Quality | Time | FPS | Memory |
|--------|---------|------|-----|--------|
| **toktx** | fast | 4.30s | 23.3 fps | ~593 MB |
| **Stream encoder (sequential)** | fast | 4.74s | 21.1 fps | ~119 MB |
| **Stream encoder (parallel)** | fast | 2.21s | **45.2 fps** | ~119 MB |
| **toktx** | thorough | 32.7s | 3.1 fps | ~593 MB |
| **Stream encoder (parallel)** | thorough | 32.6s | 3.1 fps | ~119 MB |

**Key benefits:**
- **5× less memory** (~119 MB vs ~593 MB for 100 frames)
- **1.9× faster** with parallel processing (fast quality)
- **No 2GB file size limit** (toktx has this limitation)
- **Constant memory** regardless of frame count

### When to Use the Stream Encoder

- **Long videos** (>100 frames) - constant memory usage
- **High resolution** (4K+) - avoids RAM exhaustion
- **Large files** (>2GB output) - no file size limit
- **Limited RAM systems** - uses ~5× less memory

### Standalone Stream Encoder

`texenc-stream` has its own defaults: `fast` quality, no compression and no alpha unless you pass `--zstd` and `--alpha`. Perceptual mode is on, as in `texenc`; `--no-perceptual` turns it off.

```bash
# From PNG frames
texenc-stream \
  --input ./frames \
  --output output.ktx2 \
  --block 4x4 \
  --quality fast \
  --alpha \
  --zstd 18

# From video
texenc-stream \
  --video input.mp4 \
  --output output.ktx2 \
  --frames 1000 \
  --block 4x4 \
  --quality fast \
  --zstd 18
```

Run `texenc-stream --help` for all options.

## Playback

Play the output with [alpha-video-gpu](https://github.com/MediaCacheDev/alpha-video-gpu) (React Native, Android, iOS and web).

## Demo and related packages

[alpha-video-test](https://github.com/MediaCacheDev/alpha-video-test) is a React Native app (Android, iOS and web) that plays the same video as KTX2/ASTC, WebM, APNG and AVIF side by side, with FPS, CPU and memory readouts.

- [alpha-video-gpu](https://github.com/MediaCacheDev/alpha-video-gpu): the player for this encoder's files.
- [alpha-video](https://github.com/MediaCacheDev/alpha-video): WebM VP9 and AV1 with alpha, for when file size matters more than CPU use.

## License

MIT
