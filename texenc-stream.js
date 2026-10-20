#!/usr/bin/env node
// texenc-stream.js
// Memory-efficient streaming texture encoder - processes one frame at a time
// Uses astcenc CLI to compress each frame individually
// Memory usage: ~50MB per frame instead of all frames at once
//
// Prerequisites (README "Prerequisites" has the install commands):
// - astcenc: https://github.com/ARM-software/astc-encoder/releases, on PATH, in $ASTCENC or via --astcenc
// - ffmpeg for --video; ffprobe unless --width, --height (and --frames for video) are given
// - zstd for --zstd
//
// Usage:
//   node texenc-stream.js \
//     --video input.mp4 \
//     --output output.ktx2 \
//     --width 1920 --height 1080 \
//     --frames 1000 \
//     --block 4x4 \
//     --quality fast
//
// Or with PNG frames:
//   node texenc-stream.js \
//     --input ./frames \
//     --output output.ktx2 \
//     --block 4x4 \
//     --quality fast

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { once } = require('events');
const os = require('os');
const { resolveAstcenc, defaultParallelism, exitUnlessToolFound, INSTALL_HINTS } = require('./tools');
const { LevelCompressor, layersPerSeekPoint } = require('./zstd-level');
const {
  DFD_FLAG_ALPHA_PREMULTIPLIED, parseFrameRate, formatFrameRate, probeFrameRate, kvdEntry, animDataValue, compareKeys,
} = require('./ktx2-keys');
let sharp = null;  // Lazy-loaded for alpha premultiplication

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  video: null,
  input: null,  // PNG directory input
  output: null,
  width: null,  // Auto-detect from input
  height: null, // Auto-detect from input
  frames: null,
  fps: null,  // Auto-detect from video, else 30
  block: '4x4',
  quality: 'fast',
  astcenc: null,  // --astcenc, else $ASTCENC, else astcenc on PATH
  zstd: 0,  // KTX2 internal zstd level (0 = none, 1-22)
  seekInterval: 8,  // MB of ASTC per zstd frame (seek point); 0 = one stream
  parallel: defaultParallelism(),  // Parallel astcenc processes
  alpha: false,  // Enable alpha channel with premultiplication
  perceptual: true,  // astcenc -perceptual
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--video' || arg === '-v') options.video = args[++i];
  else if (arg === '--input' || arg === '-i') options.input = args[++i];
  else if (arg === '--output' || arg === '-o') options.output = args[++i];
  else if (arg === '--width' || arg === '-w') options.width = parseInt(args[++i]);
  else if (arg === '--height' || arg === '-h') options.height = parseInt(args[++i]);
  else if (arg === '--frames' || arg === '-f') options.frames = parseInt(args[++i]);
  else if (arg === '--fps') options.fps = args[++i];
  else if (arg === '--block' || arg === '-b') options.block = args[++i];
  else if (arg === '--quality' || arg === '-q') options.quality = args[++i];
  else if (arg === '--astcenc') options.astcenc = args[++i];
  else if (arg === '--zstd') options.zstd = parseInt(args[++i]);
  else if (arg === '--seek-interval') options.seekInterval = parseFloat(args[++i]);
  else if (arg === '--parallel' || arg === '-j') options.parallel = parseInt(args[++i]);
  else if (arg === '--alpha' || arg === '-a') options.alpha = true;
  else if (arg === '--no-perceptual') options.perceptual = false;
  else if (arg === '--help') {
    console.log(`
KTX2 Streaming Encoder - Memory Efficient

Usage: node texenc-stream.js [options]

Options:
  -v, --video <file>     Input video file (use --video OR --input)
  -i, --input <dir>      Input PNG directory (use --video OR --input)
  -o, --output <file>    Output KTX2 file (required)
  -w, --width <pixels>   Frame width (auto-detected from input)
  -h, --height <pixels>  Frame height (auto-detected from input)
  -f, --frames <count>   Number of frames to process (optional, auto-detected if omitted)
  --fps <rate>           Frame rate: 30, 29.97 or 30000/1001 (default: the video's, else 30)
  -b, --block <NxN>      ASTC block size (default: 4x4)
  -q, --quality <level>  Quality: fastest,fast,medium,thorough,exhaustive (default: fast)
  -j, --parallel <N>     Parallel astcenc processes (default: performance cores on
                         Apple silicon, otherwise CPU cores - 1)
  -a, --alpha            Enable alpha channel with premultiplication (PNG input needs sharp)
  --astcenc <path>       astcenc binary (default: $ASTCENC, then astcenc on PATH)
  --zstd <level>         KTX2 internal zstd supercompression level (1-22, default: 0 = none)
  --seek-interval <MB>   With --zstd: a seek point every <MB> of ASTC, so seeks decode at most
                         that much (default: 8). 0 writes one zstd stream: the smallest file,
                         for clips that only play and loop
  --no-perceptual        Optimize for RMS error instead of perceived quality (astcenc -perceptual is on by default)

Memory Usage: ~50MB per frame (not all frames at once!)
`);
    process.exit(0);
  }
}

// Validate options
if ((!options.video && !options.input) || !options.output) {
  console.error('❌ --output is required, and either --video or --input must be specified');
  process.exit(1);
}

if (options.video && options.input) {
  console.error('❌ Use either --video or --input, not both');
  process.exit(1);
}

if (!(options.seekInterval >= 0)) {
  console.error('❌ --seek-interval must be 0 (one stream) or a size in MB');
  process.exit(1);
}

options.astcenc = resolveAstcenc(options.astcenc);
if (!options.astcenc || !fs.existsSync(options.astcenc)) {
  console.error(`❌ astcenc not found${options.astcenc ? `: ${options.astcenc}` : ' (looked at --astcenc, $ASTCENC and PATH)'}`);
  console.error(`   ${INSTALL_HINTS.astcenc}`);
  process.exit(1);
}
if (options.video) exitUnlessToolFound('ffmpeg', '--video input');
if (!options.width || !options.height || (options.video && (!options.frames || !options.fps))) {
  exitUnlessToolFound('ffprobe', 'detecting the frame size, count and rate (or pass --width, --height, --frames and --fps)');
}
if (options.zstd > 0) exitUnlessToolFound('zstd', '--zstd');

let frameRate;
if (options.fps) {
  frameRate = parseFrameRate(options.fps);
  if (!frameRate) {
    console.error(`❌ --fps must be a positive rate such as 30, 29.97 or 30000/1001 (got ${options.fps})`);
    process.exit(1);
  }
} else if (options.video) {
  frameRate = probeFrameRate(options.video);
  if (!frameRate) {
    console.error(`⚠️  Couldn't read the frame rate of ${options.video}; using 30 (pass --fps to set it)`);
  }
}
frameRate = frameRate || parseFrameRate(30);

// Premultiplying PNG input needs sharp; video frames arrive from ffmpeg as raw pixels
if (options.alpha && options.input) {
  try {
    sharp = require('sharp');
  } catch (e) {
    console.error('❌ --alpha with --input requires sharp: npm install sharp');
    process.exit(1);
  }
}

// Parse block size
const [blockX, blockY] = options.block.split('x').map(Number);

// For PNG input: scan directory and auto-detect dimensions
let pngFrameFiles = [];
if (options.input) {
  if (!fs.existsSync(options.input)) {
    console.error(`❌ Input directory not found: ${options.input}`);
    process.exit(1);
  }
  
  // Get sorted list of PNG files
  pngFrameFiles = fs.readdirSync(options.input)
    .filter(f => f.toLowerCase().endsWith('.png'))
    .sort()
    .map(f => path.join(options.input, f));
  
  if (pngFrameFiles.length === 0) {
    console.error(`❌ No PNG files found in: ${options.input}`);
    process.exit(1);
  }
  
  // Use --frames to limit, or process all if not specified
  if (options.frames && options.frames < pngFrameFiles.length) {
    pngFrameFiles = pngFrameFiles.slice(0, options.frames);
  }
  options.frames = pngFrameFiles.length;
  
  // Auto-detect dimensions from first frame using sharp or ffprobe
  if (!options.width || !options.height) {
    try {
      // Use ffprobe to get dimensions (doesn't require sharp)
      const probeCmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${pngFrameFiles[0]}"`;
      const dimensions = execSync(probeCmd, { encoding: 'utf8' }).trim().split(',');
      if (!options.width) options.width = parseInt(dimensions[0]);
      if (!options.height) options.height = parseInt(dimensions[1]);
    } catch (e) {
      console.error(`❌ Failed to detect dimensions from ${pngFrameFiles[0]}`);
      console.error('   Specify dimensions manually with -w <width> -h <height>');
      process.exit(1);
    }
  }
}

// For video input: auto-detect frame count if not specified, auto-detect dimensions
if (options.video) {
  // Auto-detect frame count from video if not specified
  if (!options.frames) {
    try {
      const countCmd = `ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 "${options.video}"`;
      const frameCount = parseInt(execSync(countCmd, { encoding: 'utf8' }).trim());
      if (isNaN(frameCount) || frameCount <= 0) {
        throw new Error('Invalid frame count');
      }
      options.frames = frameCount;
    } catch (e) {
      console.error(`❌ Failed to detect frame count from ${options.video}`);
      console.error('   Specify frame count manually with -f <frames>');
      process.exit(1);
    }
  }
  
  // Auto-detect dimensions from video
  if (!options.width || !options.height) {
    try {
      const probeCmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${options.video}"`;
      const dimensions = execSync(probeCmd, { encoding: 'utf8' }).trim().split(',');
      if (!options.width) options.width = parseInt(dimensions[0]);
      if (!options.height) options.height = parseInt(dimensions[1]);
    } catch (e) {
      console.error(`❌ Failed to detect dimensions from ${options.video}`);
      console.error('   Specify dimensions manually with -w <width> -h <height>');
      process.exit(1);
    }
  }
}

// Calculate ASTC compressed size per frame
// ASTC block is 16 bytes, covers blockX * blockY pixels
const blocksX = Math.ceil(options.width / blockX);
const blocksY = Math.ceil(options.height / blockY);
const astcFrameSize = blocksX * blocksY * 16;

console.log('🚀 KTX2 Streaming Encoder (Memory Efficient)');
console.log(`   Input: ${options.video || options.input}`);
console.log(`   Output: ${options.output}`);
console.log(`   Dimensions: ${options.width}x${options.height}`);
console.log(`   Frames: ${options.frames} at ${formatFrameRate(frameRate)} fps`);
console.log(`   Alpha: ${options.alpha ? 'Yes (premultiplied)' : 'No'}`);
console.log(`   ASTC block: ${options.block}`);
console.log(`   Quality: ${options.quality}${options.perceptual ? ', perceptual' : ''}`);
console.log(`   ASTC frame size: ${(astcFrameSize / 1024).toFixed(1)} KB`);
console.log(`   Total output: ~${(astcFrameSize * options.frames / 1024 / 1024).toFixed(1)} MB`);
console.log(`   Memory per frame: ~${(options.width * options.height * 3 / 1024 / 1024).toFixed(1)} MB`);
console.log();

// Create temp directory
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktx2-stream-'));

// KTX2 file format constants
const KTX2_MAGIC = Buffer.from([0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A]);

// VkFormat for ASTC
const VK_FORMAT_ASTC = {
  '4x4': 157,   // VK_FORMAT_ASTC_4x4_UNORM_BLOCK
  '5x4': 159,
  '5x5': 161,
  '6x5': 163,
  '6x6': 165,
  '8x5': 167,
  '8x6': 169,
  '8x8': 171,
  '10x5': 173,
  '10x6': 175,
  '10x8': 177,
  '10x10': 179,
  '12x10': 181,
  '12x12': 183,
};

const vkFormat = VK_FORMAT_ASTC[options.block] || 157;

// Build KTX2 header
// supercompressionScheme: 0 = none, 2 = Zstandard
function buildKTX2Header(width, height, layerCount, supercompressionScheme = 0) {
  const header = Buffer.alloc(80);
  let offset = 0;
  
  // Magic
  KTX2_MAGIC.copy(header, offset); offset += 12;
  
  // vkFormat (4 bytes)
  header.writeUInt32LE(vkFormat, offset); offset += 4;
  
  // typeSize (4 bytes) - 1 for compressed
  header.writeUInt32LE(1, offset); offset += 4;
  
  // pixelWidth (4 bytes)
  header.writeUInt32LE(width, offset); offset += 4;
  
  // pixelHeight (4 bytes)
  header.writeUInt32LE(height, offset); offset += 4;
  
  // pixelDepth (4 bytes) - 0 for 2D
  header.writeUInt32LE(0, offset); offset += 4;
  
  // layerCount (4 bytes)
  header.writeUInt32LE(layerCount, offset); offset += 4;
  
  // faceCount (4 bytes) - 1 for non-cubemap
  header.writeUInt32LE(1, offset); offset += 4;
  
  // levelCount (4 bytes) - 1 for no mipmaps
  header.writeUInt32LE(1, offset); offset += 4;
  
  // supercompressionScheme (4 bytes) - 0 = none, 2 = Zstandard
  header.writeUInt32LE(supercompressionScheme, offset); offset += 4;
  
  // DFD byte offset (4 bytes) - will be filled later
  header.writeUInt32LE(0, offset); offset += 4;
  
  // DFD byte length (4 bytes) - will be filled later
  header.writeUInt32LE(0, offset); offset += 4;
  
  // KVD byte offset (4 bytes)
  header.writeUInt32LE(0, offset); offset += 4;
  
  // KVD byte length (4 bytes)
  header.writeUInt32LE(0, offset); offset += 4;
  
  // SGD byte offset (8 bytes)
  header.writeBigUInt64LE(0n, offset); offset += 8;
  
  // SGD byte length (8 bytes)
  header.writeBigUInt64LE(0n, offset); offset += 8;
  
  return header;
}

// Build level index
// For supercompression: byteLength = compressed size, uncompressedByteLength = original size
function buildLevelIndex(byteOffset, byteLength, uncompressedByteLength = null) {
  const index = Buffer.alloc(24);
  index.writeBigUInt64LE(BigInt(byteOffset), 0);
  index.writeBigUInt64LE(BigInt(byteLength), 8);
  index.writeBigUInt64LE(BigInt(uncompressedByteLength ?? byteLength), 16);
  return index;
}

// Build DFD for ASTC (copied from libktx reference output)
function buildASTCDFD(blockX, blockY, premultiplied) {
  // DFD structure from libktx v4.4.2 for ASTC 4x4
  // Total size: 44 bytes
  const dfd = Buffer.alloc(44);
  let offset = 0;
  
  // dfdTotalSize (4 bytes)
  dfd.writeUInt32LE(44, offset); offset += 4;
  
  // vendorId (2 bytes) - 0 = Khronos
  dfd.writeUInt16LE(0, offset); offset += 2;
  
  // descriptorType (2 bytes) - 0 = basic format
  dfd.writeUInt16LE(0, offset); offset += 2;
  
  // versionNumber (2 bytes) - 2 = KHR_DF_VERSIONNUMBER_1_3
  dfd.writeUInt16LE(2, offset); offset += 2;
  
  // descriptorBlockSize (2 bytes) - 40 bytes (0x28)
  dfd.writeUInt16LE(40, offset); offset += 2;
  
  // colorModel (1 byte) - 162 = KHR_DF_MODEL_ASTC
  dfd.writeUInt8(162, offset); offset += 1;
  
  // colorPrimaries (1 byte) - 1 = BT709
  dfd.writeUInt8(1, offset); offset += 1;
  
  // transferFunction (1 byte) - 1 = LINEAR
  dfd.writeUInt8(1, offset); offset += 1;
  
  // flags (1 byte) - premultiplied or straight alpha
  dfd.writeUInt8(premultiplied ? DFD_FLAG_ALPHA_PREMULTIPLIED : 0, offset); offset += 1;
  
  // texelBlockDimension0 (1 byte) - blockX - 1
  dfd.writeUInt8(blockX - 1, offset); offset += 1;
  
  // texelBlockDimension1 (1 byte) - blockY - 1
  dfd.writeUInt8(blockY - 1, offset); offset += 1;
  
  // texelBlockDimension2 (1 byte) - 0
  dfd.writeUInt8(0, offset); offset += 1;
  
  // texelBlockDimension3 (1 byte) - 0
  dfd.writeUInt8(0, offset); offset += 1;
  
  // bytesPlane0-7 (8 bytes) - 16, 0, 0, 0, 0, 0, 0, 0
  dfd.writeUInt8(16, offset); offset += 1;
  dfd.writeUInt8(0, offset); offset += 1;
  dfd.writeUInt8(0, offset); offset += 1;
  dfd.writeUInt8(0, offset); offset += 1;
  dfd.writeUInt8(0, offset); offset += 1;
  dfd.writeUInt8(0, offset); offset += 1;
  dfd.writeUInt8(0, offset); offset += 1;
  dfd.writeUInt8(0, offset); offset += 1;
  
  // Sample 0 (16 bytes)
  // bitOffset (2 bytes) - 0
  dfd.writeUInt16LE(0, offset); offset += 2;
  
  // bitLength (1 byte) - 127 (128 bits - 1)
  dfd.writeUInt8(127, offset); offset += 1;
  
  // channelType (1 byte) - 0 = ASTC_DATA
  dfd.writeUInt8(0, offset); offset += 1;
  
  // samplePosition0-3 (4 bytes) - 0, 0, 0, 0
  dfd.writeUInt8(0, offset); offset += 1;
  dfd.writeUInt8(0, offset); offset += 1;
  dfd.writeUInt8(0, offset); offset += 1;
  dfd.writeUInt8(0, offset); offset += 1;
  
  // sampleLower (4 bytes) - 0x00000000
  dfd.writeUInt32LE(0x00000000, offset); offset += 4;
  
  // sampleUpper (4 bytes) - 0xFFFFFFFF
  dfd.writeUInt32LE(0xFFFFFFFF, offset); offset += 4;
  
  return dfd;
}

// KVD: KTXanimData (the frame timing) and KTXwriter (required for valid KTX2)
function buildKVD() {
  const entries = {
    KTXanimData: animDataValue(frameRate),
    KTXwriter: Buffer.from('texenc-stream\0', 'utf8'),
  };
  return Buffer.concat(Object.keys(entries).sort(compareKeys).map((key) => kvdEntry(key, entries[key])));
}

// One ffmpeg process decodes the whole input once and pipes raw BGR(A) frames, which are
// read on demand so the pipe holds ffmpeg back while astcenc catches up.
function startVideoFrames(channels) {
  const ffmpeg = spawn('ffmpeg', [
    '-v', 'error',
    '-i', options.video,
    '-an',
    '-vf', `scale=${options.width}:${options.height}`,
    '-frames:v', String(options.frames),
    '-fps_mode', 'passthrough',
    '-f', 'rawvideo',
    '-pix_fmt', channels === 4 ? 'bgra' : 'bgr24',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let errorText = '';
  ffmpeg.stderr.on('data', (data) => { errorText += data; });
  ffmpeg.on('error', (err) => { errorText += err.message; });
  const exited = once(ffmpeg, 'close');
  exited.catch(() => {});  // a failed spawn is reported through read() returning null

  const frameSize = options.width * options.height * channels;
  const chunks = ffmpeg.stdout[Symbol.asyncIterator]();
  let pending = [];
  let pendingBytes = 0;

  // Resolves to the next frame, or null once ffmpeg has no more
  async function read() {
    while (pendingBytes < frameSize) {
      const { value, done } = await chunks.next();
      if (done) return null;
      pending.push(value);
      pendingBytes += value.length;
    }
    const joined = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
    pending = joined.length > frameSize ? [joined.subarray(frameSize)] : [];
    pendingBytes = joined.length - frameSize;
    return joined.subarray(0, frameSize);
  }

  // Reads to the end of the pipe, which lets ffmpeg exit, and resolves to its exit code
  async function finish() {
    while (!(await chunks.next()).done) {}
    const [code] = await exited;
    return code;
  }

  return { read, finish, errorText: () => errorText.trim() };
}

function premultiplyBgra(pixels) {
  for (let p = 0; p < pixels.length; p += 4) {
    const a = pixels[p + 3] / 255;
    pixels[p + 0] = Math.round(pixels[p + 0] * a);
    pixels[p + 1] = Math.round(pixels[p + 1] * a);
    pixels[p + 2] = Math.round(pixels[p + 2] * a);
  }
}

// Uncompressed TGA, which astcenc reads, so frames skip PNG encoding and decoding
function writeTga(filePath, pixels, width, height, channels) {
  const header = Buffer.alloc(18);
  header[2] = 2;  // uncompressed true-colour
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header[16] = channels * 8;
  header[17] = 0x20 | (channels === 4 ? 8 : 0);  // top-left origin, alpha bits
  const fd = fs.openSync(filePath, 'w');
  fs.writeSync(fd, header);
  fs.writeSync(fd, pixels);
  fs.closeSync(fd);
}

async function main() {
  const totalAstcSize = astcFrameSize * options.frames;
  const useInnerCompression = options.zstd > 0;
  
  // Calculate offsets
  // Layout: Header (80) | Level Index (24) | DFD (44) | KVD (variable) | padding | Data
  const headerSize = 80;
  const levelIndexSize = 24;
  const levelIndexOffset = headerSize;  // Where level index starts (for patching later)
  const dfd = buildASTCDFD(blockX, blockY, options.alpha);
  const kvd = buildKVD();
  
  const dfdOffset = headerSize + levelIndexSize;
  const kvdOffset = dfdOffset + dfd.length;
  const afterKvd = kvdOffset + kvd.length;
  
  // Build header - use supercompressionScheme=2 for inner compression
  const supercompressionScheme = useInnerCompression ? 2 : 0;
  
  // Uncompressed ASTC level data starts on a 16-byte boundary (the block size);
  // supercompressed level data follows the KVD directly, with no padding.
  const alignedDataOffset = supercompressionScheme === 0 ? Math.ceil(afterKvd / 16) * 16 : afterKvd;
  const padding = alignedDataOffset - afterKvd;
  const header = buildKTX2Header(options.width, options.height, options.frames, supercompressionScheme);
  header.writeUInt32LE(dfdOffset, 48);   // dfdByteOffset at 0x30
  header.writeUInt32LE(dfd.length, 52);  // dfdByteLength at 0x34
  header.writeUInt32LE(kvdOffset, 56);   // kvdByteOffset at 0x38
  header.writeUInt32LE(kvd.length, 60);  // kvdByteLength at 0x3C
  
  // Build placeholder level index (will patch later for inner compression)
  // For inner compression: byteLength will be patched with compressed size
  const levelIndex = buildLevelIndex(alignedDataOffset, totalAstcSize, totalAstcSize);
  
  // Create output file and write header
  const outputPath = options.output;
  const fd = fs.openSync(outputPath, 'w+');  // w+ for read/write (needed for patching)
  
  fs.writeSync(fd, header);
  fs.writeSync(fd, levelIndex);
  fs.writeSync(fd, dfd);
  fs.writeSync(fd, kvd);
  if (padding > 0) {
    fs.writeSync(fd, Buffer.alloc(padding));
  }
  
  // Extract frames in batches to balance disk usage and speed
  // Batch size: process N frames at a time to limit temp disk usage
  const batchSize = Math.min(50, options.frames);  // Max 50 frames in temp at once
  const parallelJobs = options.parallel;
  
  // For inner compression: compressed level data goes straight to the KTX2 file
  let levelCompressor = null;
  
  if (useInnerCompression) {
    const seekLayers = layersPerSeekPoint(options.seekInterval, astcFrameSize);
    console.log(`📦 Using KTX2 internal zstd compression (level ${options.zstd})`);
    console.log(seekLayers > 0 && seekLayers < options.frames
      ? `   Seek point every ${seekLayers} frames (${(seekLayers * astcFrameSize / 1024 / 1024).toFixed(1)} MB)`
      : '   One zstd stream (no seek points)');
    levelCompressor = new LevelCompressor({
      level: options.zstd,
      layersPerSeekPoint: seekLayers,
      parallel: parallelJobs,
      write: (chunk) => fs.writeSync(fd, chunk),
    });
  }
  
  console.log('📦 Encoding frames...');
  console.log(`   (Processing in batches of ${batchSize}, ${parallelJobs} parallel jobs)`);
  
  let framesProcessed = 0;
  
  // Helper function to run astcenc in parallel
  async function encodeFramesParallel(frameJobs) {
    const { spawn } = require('child_process');
    
    return new Promise((resolve, reject) => {
      let completed = 0;
      let failed = false;
      const results = new Array(frameJobs.length);
      
      // Process in chunks of parallelJobs
      let running = 0;
      let nextJob = 0;
      
      function startNext() {
        while (running < parallelJobs && nextJob < frameJobs.length && !failed) {
          const jobIndex = nextJob++;
          const job = frameJobs[jobIndex];
          running++;
          
          const astcencArgs = ['-cl', job.imagePath, job.astcPath, options.block, `-${options.quality}`, '-silent'];
          if (options.perceptual) astcencArgs.push('-perceptual');
          const proc = spawn(options.astcenc, astcencArgs, { stdio: 'pipe' });
          
          proc.on('close', (code) => {
            running--;
            if (code !== 0 && !failed) {
              failed = true;
              reject(new Error(`astcenc failed on ${job.imagePath}`));
              return;
            }
            
            results[jobIndex] = job;
            completed++;
            
            if (completed === frameJobs.length) {
              resolve(results);
            } else {
              startNext();
            }
          });
          
          proc.on('error', (err) => {
            if (!failed) {
              failed = true;
              reject(err);
            }
          });
        }
      }
      
      startNext();
    });
  }
  
  const videoChannels = options.alpha ? 4 : 3;
  const videoFrames = options.video ? startVideoFrames(videoChannels) : null;

  for (let batchStart = 0; batchStart < options.frames; batchStart += batchSize) {
    const batchEnd = Math.min(batchStart + batchSize, options.frames);
    const batchFrames = batchEnd - batchStart;
    
    const batchDir = path.join(tempDir, `batch_${batchStart}`);
    fs.mkdirSync(batchDir, { recursive: true });
    
    let jobs;
    
    if (options.video) {
      jobs = [];
      for (let j = 0; j < batchFrames; j++) {
        const pixels = await videoFrames.read();
        if (!pixels) {
          const detail = videoFrames.errorText();
          console.error(`\n❌ ffmpeg stopped after ${batchStart + j} of ${options.frames} frames${detail ? `: ${detail}` : ''}`);
          fs.closeSync(fd);
          fs.rmSync(tempDir, { recursive: true });
          process.exit(1);
        }
        if (options.alpha) premultiplyBgra(pixels);
        const imagePath = path.join(batchDir, `frame_${j}.tga`);
        writeTga(imagePath, pixels, options.width, options.height, videoChannels);
        jobs.push({
          index: j,
          imagePath,
          astcPath: path.join(batchDir, `frame_${j}.astc`),
          deleteAfter: true
        });
      }
    } else {
      // PNG input: use files directly from input directory
      const batchFiles = pngFrameFiles.slice(batchStart, batchEnd);
      
      if (options.alpha && sharp) {
        // Premultiply alpha for each frame in batch
        jobs = await Promise.all(batchFiles.map(async (srcPath, j) => {
          const premultPath = path.join(batchDir, `premult_${j}.png`);
          
          // Read image with ensureAlpha
          const rawBuffer = await sharp(srcPath)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          
          const { data, info } = rawBuffer;
          
          // Manual premultiplication: RGB * alpha
          const premultiplied = Buffer.alloc(data.length);
          for (let p = 0; p < data.length; p += 4) {
            const a = data[p + 3] / 255;
            premultiplied[p + 0] = Math.round(data[p + 0] * a);
            premultiplied[p + 1] = Math.round(data[p + 1] * a);
            premultiplied[p + 2] = Math.round(data[p + 2] * a);
            premultiplied[p + 3] = data[p + 3];
          }
          
          await sharp(premultiplied, {
            raw: { width: info.width, height: info.height, channels: 4 }
          }).png().toFile(premultPath);
          
          return {
            index: j,
            imagePath: premultPath,
            astcPath: path.join(batchDir, `frame_${j}.astc`),
            deleteAfter: true  // Delete premultiplied temp files
          };
        }));
      } else {
        jobs = batchFiles.map((pngPath, j) => ({
          index: j,
          imagePath: pngPath,
          astcPath: path.join(batchDir, `frame_${j}.astc`),
          deleteAfter: false  // Don't delete source PNG files
        }));
      }
    }
    
    // Encode all frames in parallel
    try {
      await encodeFramesParallel(jobs);
    } catch (e) {
      console.error(`\n❌ Parallel encoding failed: ${e.message}`);
      fs.closeSync(fd);
      fs.rmSync(tempDir, { recursive: true });
      process.exit(1);
    }
    
    // Write ASTC data to KTX2 in order (or pipe through zstd for inner compression)
    for (let j = 0; j < jobs.length; j++) {
      const job = jobs[j];
      const astcPath = job.astcPath;
      
      // Read ASTC file (skip 16-byte header)
      const astcData = fs.readFileSync(astcPath);
      const astcPayload = astcData.slice(16);  // Skip .astc file header
      
      if (astcPayload.length !== astcFrameSize) {
        console.error(`\n❌ Frame ${batchStart + j + 1}: unexpected ASTC size ${astcPayload.length}, expected ${astcFrameSize}`);
      }
      
      // Write to KTX2 (directly or through zstd)
      if (levelCompressor) {
        await levelCompressor.addLayer(astcPayload);
      } else {
        fs.writeSync(fd, astcPayload);
      }
      
      // Cleanup: delete ASTC file, and PNG only if extracted from video
      fs.unlinkSync(astcPath);
      if (job.deleteAfter) {
        fs.unlinkSync(job.imagePath);
      }
      
      framesProcessed++;
    }
    
    // Progress
    process.stdout.write(`\r   Frame ${framesProcessed}/${options.frames} (${(framesProcessed / options.frames * 100).toFixed(0)}%)`);
    
    // Cleanup batch directory
    fs.rmSync(batchDir, { recursive: true });
  }
  
  if (videoFrames) {
    const code = await videoFrames.finish();
    if (code !== 0) {
      console.error(`\n❌ ffmpeg exited with code ${code}: ${videoFrames.errorText()}`);
      fs.closeSync(fd);
      fs.rmSync(tempDir, { recursive: true });
      process.exit(1);
    }
  }

  console.log('\n✓ All frames encoded');
  
  // For inner compression: finish the level data, patch header
  if (levelCompressor) {
    const compressedBytesWritten = await levelCompressor.finish();
    
    console.log(`✓ Compressed: ${(totalAstcSize / 1024 / 1024).toFixed(2)} MB → ${(compressedBytesWritten / 1024 / 1024).toFixed(2)} MB (${(totalAstcSize / compressedBytesWritten).toFixed(2)}x)`);
    if (levelCompressor.seekPoints > 0) {
      console.log(`✓ Seek table: ${levelCompressor.seekPoints} seek points`);
    }
    
    // Patch the level index with actual compressed size
    // Level index is at offset 80 (after header)
    // Format: byteOffset (8) | byteLength (8) | uncompressedByteLength (8)
    const patchedLevelIndex = buildLevelIndex(alignedDataOffset, compressedBytesWritten, totalAstcSize);
    
    // Seek to level index position and write patched data
    fs.writeSync(fd, patchedLevelIndex, 0, patchedLevelIndex.length, levelIndexOffset);
    
    console.log(`✓ Patched level index: compressed=${compressedBytesWritten}, uncompressed=${totalAstcSize}`);
  }
  
  fs.closeSync(fd);
  fs.rmSync(tempDir, { recursive: true });
  
  const stats = fs.statSync(outputPath);
  console.log(`✓ Output: ${outputPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
  
  if (useInnerCompression) {
    console.log(`✓ Final output: ${outputPath} (KTX2 internal zstd, supercompressionScheme=2)`);
  }
  
  console.log('\n✅ Done!');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
