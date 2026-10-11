# alpha-video-gpu-encoder

Encodes video files and PNG sequences into GPU-compressed KTX2 texture streams for [alpha-video-gpu](https://github.com/danielkpl2/alpha-video-gpu).

## What It Does

1. **Extracts frames** from video files (MP4, MOV, etc.) or reads PNG sequences
2. **Encodes to ASTC** using `toktx` (KTX-Software) or `astcenc` (ARM)
3. **Packs into KTX2** texture arrays with optional zstd compression
4. **Injects animation metadata** (`BasisPlayerMetadata`) into the KTX2 key-value data
5. **Supports streaming** - constant memory playback regardless of video length

## Terminology

| Term | Full Name | Description |
|------|-----------|-------------|
| **KTX2** | Khronos Texture 2.0 | Container format for GPU-compressed textures. Stores texture data with metadata, supports mipmaps, texture arrays, and internal compression. Think of it as "MP4 for textures". |
| **ASTC** | Adaptive Scalable Texture Compression | GPU texture compression format developed by ARM. Supported natively on all modern mobile GPUs (iOS, Android) and Apple Silicon Macs. Offers configurable quality/size tradeoff via block sizes (4x4 to 12x12). |
| **UASTC** | Universal ASTC | A variant of ASTC from Basis Universal that can be transcoded at runtime to other GPU formats (BC7, ETC2, PVRTC). Use when you need to support older GPUs that don't have native ASTC. Slightly larger files than native ASTC. |
| **Zstd** | Zstandard | Fast lossless compression algorithm by Facebook. Used to compress ASTC data for smaller file sizes. Decompresses at ~1GB/s on modern hardware. |
| **Texture Array** | 2D Texture Array | GPU feature that stores multiple 2D images as layers in a single texture. Each animation frame is one layer. More efficient than individual textures. |
| **astcenc** | ASTC Encoder | ARM's official ASTC compression tool. Used by the stream encoder for memory-efficient encoding. |
| **toktx** | To KTX | KTX-Software's tool for creating KTX2 files. Supports both ASTC and UASTC encoding. |
| **Premultiplied Alpha** | - | Alpha blending technique where RGB values are pre-multiplied by alpha. Prevents dark "halo" artifacts around transparent edges. This encoder always premultiplies when alpha is enabled. |

### ASTC vs UASTC

| Feature | ASTC (Native) | UASTC |
|---------|---------------|-------|
| **File size** | Smaller | ~15% larger |
| **GPU support** | iOS, Android, Apple Silicon | Universal (transcodes to any format) |
| **Load time** | Instant (direct upload) | Requires transcoding (~50ms) |
| **Quality** | Highest | Very high |
| **Use case** | Mobile apps, Apple platforms | Web, cross-platform |

**Recommendation:** Use native ASTC for mobile apps and Apple platforms. Use UASTC only if you need to support older desktop GPUs without ASTC.

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

**How it works:** ASTC is adaptive - it analyzes each block and chooses the best encoding strategy. For smooth gradients (common in animations and effects), larger blocks work well because there's less high-frequency detail to preserve. For sharp edges or fine text, smaller blocks are needed.

**Recommendation:** Start with **6x6** for animated content with alpha. It offers ~56% file size reduction with virtually no visible quality loss for most use cases. Drop to **8x8** for even smaller files if quality is acceptable. Use **4x4** (the default) when you need maximum quality for detailed content.

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
| Many UI animations | GPU texture (low CPU) |
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
| **Outer zstd** | Whole-file `.ktx2.zst` wrapper | Progressive download + decompress |
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
| `toktx` (KTX-Software) | Default encode path, UASTC, atlas mode | `brew install ktx` |
| `ffmpeg` + `ffprobe` | `--video` input and dimension probing | `brew install ffmpeg` |
| `zstd` | Any `--zstd` level above 0 | `brew install zstd` |
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

The default `--astcenc` path is `./astcenc-sdk/bin/astcenc`, relative to the directory you run the command from. Pass `--astcenc /path/to/astcenc` if it lives elsewhere.

## Usage

### Basic Usage (Recommended)

Simplest command - auto-detects dimensions, uses sensible defaults (texture array, ASTC 4x4, `thorough` quality, inner zstd 18, alpha on):

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

### Atlas Mode

For shorter animations, packs frames into a 2D grid instead of a texture array:

```bash
texenc --input ./frames --output output.ktx2 --fps 30 --mode atlas
```

### UASTC Mode

For universal compatibility (transcodes at runtime):

```bash
texenc --input ./frames --output output.ktx2 --fps 30 --uastc
```

## Parameters

### Input / Output

| Parameter | Description |
|-----------|-------------|
| `-i, --input <dir>` | Input directory containing PNG frames (use `--input` or `--video`) |
| `-v, --video <file>` | Input video file; frames are extracted with ffmpeg |
| `--frame-count <num>` | Number of frames to extract (required with `--video`) |
| `-o, --output <path>` | **Required.** Output path (extension auto-determined: `.ktx2` for single, `.glb` for multi-part) |

### Frame Options

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-w, --width <px>` | auto | Frame width (auto-detected from input) |
| `-h, --height <px>` | auto | Frame height (auto-detected from input) |
| `-f, --fps <num>` | 30 | Frame rate for playback |
| `--mode <type>` | array | `array` (texture array, 1 frame per layer) or `atlas` (frames in a grid) |
| `--max-texture-size <px>` | 8192 | Maximum texture size before splitting into parts (atlas mode) |

### Encoding Mode

| Parameter | Description |
|-----------|-------------|
| `--astc` | Native ASTC encoding (default; highest quality, requires an ASTC GPU) |
| `--uastc` | UASTC encoding (universal, transcodes at runtime) |

### ASTC Options

| Parameter | Default | Range/Values | Description |
|-----------|---------|--------------|-------------|
| `--astc-quality <level>` | thorough | fastest, fast, medium, thorough, exhaustive | Encoding quality level |
| `--astc-block <size>` | 4x4 | 4x4, 5x4, 5x5, 6x5, 6x6, 8x5, 8x6, 8x8, 10x5, 10x6, 10x8, 10x10, 12x10, 12x12 | Block size (smaller = higher quality, larger file) |
| `--astc-perceptual` | off | flag | Optimize for perceptual quality |
| `--zstd <level>` | 18 | 0-22 | Zstandard compression level (higher = smaller, slower; 0 = uncompressed) |
| `--outer-compression` | off | flag | Use outer `.zst` wrapper instead of KTX2 internal zstd |

### UASTC Options

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| `--uastc-level <level>` | 4 | 0-4 | Encoding level (higher = better quality, slower) |
| `--uastc-rdo <lambda>` | off | 0-10 | RDO quality (0.25 = high quality, 3.0 = small file) |

### Other Options

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--no-alpha` | off | Disable alpha channel (for opaque content) |
| `--use-stream-encoder` | off | Use the memory-efficient stream encoder (requires `astcenc`) |
| `--astcenc <path>` | `./astcenc-sdk/bin/astcenc` | Path to astcenc binary |
| `--toktx <path>` | toktx | Path to toktx binary |
| `--keep-atlas` | off | Keep intermediate atlas PNG file (atlas mode) |
| `--no-glb` | off | Output separate KTX2 files instead of a GLB container (multi-part atlas) |
| `--json-metadata` | off | Output separate JSON metadata file |
| `-y, --yes` | off | Non-interactive mode (skip prompts, for scripts) |

## Output Formats

### Texture Array (default)
- A single `.ktx2` file, one frame per array layer, with embedded metadata.

### Single Atlas (`--mode atlas`)
When all frames fit in one atlas (within `--max-texture-size`):
- A single `.ktx2` file with embedded metadata.

### Multi-Part Atlas (`--mode atlas`)
When frames exceed the max texture size:
- **With GLB (default):** a single `.glb` file containing all KTX2 parts + metadata
- **With `--no-glb`:** separate `_0.ktx2`, `_1.ktx2`, etc. files with metadata in the first part

## Metadata Format

The encoder embeds JSON metadata under the `BasisPlayerMetadata` KTX2 key, which the player reads.

Texture array (default):

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

Atlas:

```json
{
  "version": 2,
  "format": "ktx2",
  "mode": "astc",
  "layout": "grid-2d",
  "frameWidth": 400,
  "frameHeight": 400,
  "frameCount": 120,
  "framesPerPart": 64,
  "framesPerRow": 8,
  "maxRowsPerPart": 8,
  "partCount": 2,
  "frameRate": 30,
  "atlasWidth": 3200,
  "atlasHeight": 3200,
  "hasAlpha": true,
  "hasMipmaps": false,
  "parts": [
    {
      "index": 0,
      "startFrame": 0,
      "endFrame": 63,
      "frameCount": 64,
      "rows": 8,
      "columns": 8,
      "file": "animation_0.ktx2"
    }
  ]
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
texenc-stream --input ./frames --output output.ktx2 --zstd 18 --inner-compression --alpha
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

`texenc-stream` has its own defaults: `fast` quality, no compression and no alpha unless you pass `--zstd`, `--inner-compression` and `--alpha`.

```bash
# From PNG frames
texenc-stream \
  --input ./frames \
  --output output.ktx2 \
  --block 4x4 \
  --quality fast \
  --alpha \
  --zstd 18 \
  --inner-compression

# From video
texenc-stream \
  --video input.mp4 \
  --output output.ktx2 \
  --frames 1000 \
  --block 4x4 \
  --quality fast \
  --zstd 18 \
  --inner-compression
```

Run `texenc-stream --help` for all options.

## Playback

Play the output with [alpha-video-gpu](https://github.com/danielkpl2/alpha-video-gpu) (React Native and web).

## License

MIT
