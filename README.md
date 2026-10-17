# alpha-video-gpu-encoder

Encodes video files and PNG sequences into ASTC texture arrays in KTX2 files for [alpha-video-gpu](https://github.com/MediaCacheDev/alpha-video-gpu).

## What It Does

1. **Extracts frames** from video files (MP4, MOV, etc.) or reads PNG sequences
2. **Encodes to ASTC** using `toktx` (KTX-Software) or `astcenc` (ARM)
3. **Packs into KTX2** texture arrays with optional zstd supercompression
4. **Injects video metadata** (`BasisPlayerMetadata`) into the KTX2 key-value data
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

## Why GPU Textures Instead of Video Codecs?

This encoder produces GPU texture streams, not video files. Here's why that matters:

### Video Codec Pipeline (VP9, AV1)

```
Video File → CPU Decode → YUV/YUVA → Convert to RGBA → Upload to GPU → Render
                │              │              │              │
            Heavy CPU       Planar        Per-frame      640KB/frame
            per frame       format        conversion     (400×400×4)
```

- **Excellent compression** (10-50x smaller than raw)
- **High CPU per frame** - decode + color convert
- **Battery drain** on mobile devices
- **Alpha support** - VP9/AV1 only (YUVA)

### GPU Texture Pipeline (ASTC)

```
KTX2 File → Zstd Decompress → ASTC Data → Direct GPU Upload → Render
                │                  │              │
            ~1GB/s CPU         Already GPU     71KB/frame
            (trivial)           format        (400×400×0.44)
```

- **Moderate compression** (3-10x smaller than raw)
- **Near-zero CPU** - Zstd is trivial, GPU does ASTC decompression
- **Minimal battery drain**
- **Native alpha** - ASTC includes alpha channel

### Comparison Table

| Aspect | Video Codec (VP9/AV1) | GPU Texture (ASTC) |
|--------|----------------------|-------------------|
| **File size** | Smallest | 3-5x larger |
| **CPU per frame** | High (decode + convert) | Near-zero |
| **Battery impact** | Significant | Minimal |
| **Concurrent players** | 2-4 typical | 10-50+ typical |
| **Alpha support** | VP9/AV1 only | Native |
| **Startup latency** | Codec init delay | Immediate |

### When to Use Each

| Use Case | Recommendation |
|----------|----------------|
| Single long video | Video codec (smaller files) |
| Many UI videos | GPU texture (low CPU) |
| Stickers/effects | GPU texture (many concurrent) |
| Battery-critical | GPU texture |
| Bandwidth-critical | Video codec |

### The Math (30fps, 400×400 with alpha)

**VP9 YUVA:**
- File: ~50KB/sec
- CPU: 5-15ms/frame (decode + convert)
- 10 concurrent = 50-150ms/frame → **drops frames**

**ASTC 6×6:**
- File: ~200KB/sec (4x larger)
- CPU: 0.2ms/frame (zstd only)
- 10 concurrent = 2ms/frame → **smooth 60fps**

## Compression Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **Inner zstd** (default) | KTX2 internal supercompression | Single `.ktx2` file, streaming playback |
| **Uncompressed** | No compression (`--zstd 0`) | Direct mmap, fastest load |

## Installation

```bash
npm install -g alpha-video-gpu-encoder
```

This installs two commands: `texenc` (the main CLI) and `texenc-stream` (the memory-efficient backend, also usable on its own). Node.js 18 or newer is required.

### Prerequisites

The encoder drives external tools. Install the ones your workflow needs:

| Tool | Needed for | Install (macOS) |
|------|-----------|-----------------|
| `toktx` (KTX-Software) | Default encode path | `brew install ktx` |
| `ffmpeg` + `ffprobe` (5.1 or newer) | `--video` input and dimension probing | `brew install ffmpeg` |
| `zstd` | `--zstd` above 0 with the stream encoder | `brew install zstd` |
| `astcenc` (ARM) | `--use-stream-encoder` and `texenc-stream` | See below |

### Optional: astcenc for the stream encoder

Download a release from [ARM-software/astc-encoder](https://github.com/ARM-software/astc-encoder/releases):

```bash
# macOS (universal)
curl -sL "https://github.com/ARM-software/astc-encoder/releases/download/5.3.0/astcenc-5.3.0-macos-universal.zip" -o astcenc.zip
unzip astcenc.zip -d astcenc-sdk

# Linux (x64)
curl -sL "https://github.com/ARM-software/astc-encoder/releases/download/5.3.0/astcenc-5.3.0-linux-x64.zip" -o astcenc.zip
unzip astcenc.zip -d astcenc-sdk
```

The encoders look for astcenc in this order: `--astcenc <path>`, the `ASTCENC` environment variable, then `astcenc` on `PATH` (also `astcenc-native`, `-neon`, `-avx2`, `-sse4.1` and `-sse2`, the names in ARM's release zips). For the zips above, either add `astcenc-sdk/bin` to `PATH` or point at the binary:

```bash
export ASTCENC="$PWD/astcenc-sdk/bin/astcenc"        # macOS
export ASTCENC="$PWD/astcenc-sdk/bin/astcenc-avx2"   # Linux x64
```

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

`--fps` defaults to 30. "Play with" names the `alpha-video-gpu` props; see its README for the memory options.

### Basic Usage (Recommended)

Simplest command - auto-detects dimensions, uses sensible defaults (texture array, ASTC 4x4, `thorough` quality, perceptual, inner zstd 18, alpha on):

```bash
# From PNG frames
texenc --input ./frames --output output.ktx2 --fps 30

# From video
texenc --video input.mp4 --output output.ktx2 --fps 30 --frame-count 300
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
| `-f, --fps <num>` | 30 | Frame rate for playback |

### ASTC Options

| Parameter | Default | Range/Values | Description |
|-----------|---------|--------------|-------------|
| `--astc-quality <level>` | thorough | fastest, fast, medium, thorough, exhaustive | Encoding quality level |
| `--astc-block <size>` | 4x4 | 4x4, 5x4, 5x5, 6x5, 6x6, 8x5, 8x6, 8x8, 10x5, 10x6, 10x8, 10x10, 12x10, 12x12 | Block size (smaller = higher quality, larger file) |
| `--no-astc-perceptual` | perceptual on | flag | Optimize for RMS error instead of perceived quality (toktx `--astc_perceptual`, astcenc `-perceptual`) |
| `--zstd <level>` | 18 | 0-22 | KTX2 internal Zstandard supercompression level (higher = smaller, slower; 0 = uncompressed) |

### Other Options

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--no-alpha` | off | Disable alpha channel (for opaque content) |
| `--use-stream-encoder` | off | Use the memory-efficient stream encoder (requires `astcenc`) |
| `--astcenc <path>` | `$ASTCENC`, then `astcenc` on `PATH` | astcenc binary for the stream encoder |
| `--toktx <path>` | toktx | Path to toktx binary |
| `-y, --yes` | off | Non-interactive mode (skip prompts, for scripts) |

## Output Format

A single `.ktx2` file holding an ASTC texture array, one frame per layer, with embedded metadata.

## Metadata Format

The encoder embeds JSON metadata under the `BasisPlayerMetadata` KTX2 key, which the player reads:

```json
{
  "version": 1,
  "type": "BasisPlayerMetadata",
  "packingMode": "array",
  "frameCount": 120,
  "frameRate": 30,
  "frameWidth": 400,
  "frameHeight": 400,
  "hasAlpha": true,
  "premultipliedAlpha": true,
  "mode": "astc",
  "layerCount": 120
}
```

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
