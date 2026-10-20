#!/usr/bin/env node

/**
 * PNG/Video to KTX2 Texture Encoder
 * 
 * Converts PNG frames or video to a KTX2 file holding an ASTC texture array
 * (one frame per layer), with KTX2 internal zstd supercompression by default.
 * 
 * Prerequisites (README "Prerequisites" has the install commands):
 * - toktx (KTX-Software) for the default encoder:
 *   https://github.com/KhronosGroup/KTX-Software/releases
 * - astcenc for --use-stream-encoder: https://github.com/ARM-software/astc-encoder/releases
 * - ffmpeg and ffprobe for --video, zstd for seek points and the stream encoder's --zstd
 *
 * `texenc doctor` checks the external tools instead of encoding.
 */

const { resolveAstcenc, defaultParallelism, exitUnlessToolFound, INSTALL_HINTS, runDoctor } = require('./tools');
const {
  DFD_FLAGS_OFFSET, DFD_FLAG_ALPHA_PREMULTIPLIED, parseFrameRate, formatFrameRate, probeFrameRate,
  kvdEntry, animDataValue, compareKeys,
} = require('./ktx2-keys');
const { compressLevelData, layersPerSeekPoint } = require('./zstd-level');

// Before requiring sharp, so the doctor can report it missing.
if (process.argv[2] === 'doctor') {
  const doctorArgs = process.argv.slice(3);
  const valueOf = flag => {
    const index = doctorArgs.indexOf(flag);
    return index >= 0 ? doctorArgs[index + 1] : undefined;
  };
  const ok = runDoctor({ toktx: valueOf('--toktx'), astcenc: valueOf('--astcenc') });
  process.exit(ok ? 0 : 1);
}

const sharp = require('sharp');
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { program } = require('commander');

function lcm(a, b) {
  const gcd = (x, y) => (y === 0 ? x : gcd(y, x % y));
  return (a / gcd(a, b)) * b;
}

/**
 * Adds a key/value entry (value: a Buffer) to a KTX2 file's key-value data, in sorted order.
 * KTX2 format: https://github.khronos.org/KTX-Specification/
 */
function injectKTX2KeyValue(ktx2Path, key, value) {
  const data = fs.readFileSync(ktx2Path);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  
  // Read header offsets (bytes 48-79)
  const dfdByteOffset = view.getUint32(48, true);
  const dfdByteLength = view.getUint32(52, true);
  const kvdByteOffset = view.getUint32(56, true);
  const kvdByteLength = view.getUint32(60, true);
  const sgdByteOffset = Number(view.getBigUint64(64, true));
  const sgdByteLength = Number(view.getBigUint64(72, true));
  
  // Read level index (starts at byte 80)
  const levelCount = view.getUint32(40, true) || 1;
  const levelIndexSize = levelCount * 24; // 3 x uint64 per level
  
  const newEntryBuffer = kvdEntry(key, value);
  const kvEntryTotalLength = newEntryBuffer.length;
  
  // New KVD section = old KVD + new entry
  const newKvdByteLength = kvdByteLength + kvEntryTotalLength;
  const kvdLengthDiff = newKvdByteLength - kvdByteLength;
  
  // Calculate padding difference (KVD must be aligned to 4 bytes, SGD to 8 bytes)
  const oldKvdEnd = kvdByteOffset + kvdByteLength;
  const newKvdEnd = kvdByteOffset + newKvdByteLength;
  
  // SGD padding (align to 8 bytes)
  const oldSgdPadding = sgdByteLength > 0 ? (8 - (oldKvdEnd % 8)) % 8 : 0;
  const newSgdPadding = sgdByteLength > 0 ? (8 - (newKvdEnd % 8)) % 8 : 0;
  
  // Without supercompression, level data must start on a multiple of lcm(texel block size, 4)
  // (bytesPlane0 in the DFD; 16 for ASTC and UASTC). Supercompressed level data must follow
  // the KVD/SGD directly, with no padding.
  const supercompressed = view.getUint32(44, true) !== 0;
  const bytesPlane0 = data[dfdByteOffset + 20];
  const levelAlignment = !supercompressed && bytesPlane0 > 0 ? lcm(bytesPlane0, 4) : 1;
  const levelStarts = Array.from({ length: levelCount }, (_, i) => Number(view.getBigUint64(80 + i * 24, true)));
  const oldLevelDataStart = Math.min(...levelStarts);
  const afterKvdAndSgd = sgdByteLength > 0 ? newKvdEnd + newSgdPadding + sgdByteLength : newKvdEnd;
  const newLevelDataStart = Math.ceil(afterKvdAndSgd / levelAlignment) * levelAlignment;
  const levelDataOffset = newLevelDataStart - oldLevelDataStart;
  
  // Build new file
  const newSize = data.length + levelDataOffset;
  const newData = Buffer.alloc(newSize);
  
  // Copy header (0-80) and level index
  data.copy(newData, 0, 0, 80 + levelIndexSize);
  
  // Update header offsets
  const newView = new DataView(newData.buffer, newData.byteOffset, newData.byteLength);
  newView.setUint32(60, newKvdByteLength, true); // kvdByteLength
  if (sgdByteLength > 0) {
    newView.setBigUint64(64, BigInt(sgdByteOffset + kvdLengthDiff + (newSgdPadding - oldSgdPadding)), true);
  }
  
  // Update level offsets
  for (let i = 0; i < levelCount; i++) {
    const levelOffset = 80 + i * 24;
    const oldByteOffset = Number(view.getBigUint64(levelOffset, true));
    newView.setBigUint64(levelOffset, BigInt(oldByteOffset + levelDataOffset), true);
  }
  
  // Copy DFD (unchanged position)
  data.copy(newData, dfdByteOffset, dfdByteOffset, dfdByteOffset + dfdByteLength);
  
  // Parse existing KVD entries and insert new one in sorted order
  const existingEntries = [];
  let kvdReadPos = kvdByteOffset;
  const kvdEnd = kvdByteOffset + kvdByteLength;
  
  while (kvdReadPos < kvdEnd) {
    const entryLength = view.getUint32(kvdReadPos, true);
    if (entryLength === 0) break;
    
    const entryData = data.slice(kvdReadPos + 4, kvdReadPos + 4 + entryLength);
    const nullIndex = entryData.indexOf(0);
    const entryKey = entryData.slice(0, nullIndex).toString('utf8');
    
    const entryPadding = (4 - (entryLength % 4)) % 4;
    const totalEntrySize = 4 + entryLength + entryPadding;
    
    existingEntries.push({
      key: entryKey,
      data: data.slice(kvdReadPos, kvdReadPos + totalEntrySize)
    });
    
    kvdReadPos += totalEntrySize;
  }
  
  existingEntries.push({
    key: key,
    data: newEntryBuffer
  });
  existingEntries.sort((a, b) => compareKeys(a.key, b.key));
  
  // Write sorted entries
  let writePos = kvdByteOffset;
  for (const entry of existingEntries) {
    entry.data.copy(newData, writePos);
    writePos += entry.data.length;
  }
  
  // Copy SGD if present
  if (sgdByteLength > 0) {
    // Add SGD padding
    writePos += newSgdPadding;
    const newSgdOffset = writePos;
    data.copy(newData, newSgdOffset, sgdByteOffset, sgdByteOffset + sgdByteLength);
    writePos = newSgdOffset + sgdByteLength;
  }
  
  // Copy level data
  data.copy(newData, newLevelDataStart, oldLevelDataStart, data.length);
  
  fs.writeFileSync(ktx2Path, newData);
  console.log(`   ✓ Added key "${key}" (${value.length} bytes)`);
}

/** Sets KHR_DF_FLAG_ALPHA_PREMULTIPLIED in the DFD; toktx writes straight alpha. */
function markAlphaPremultiplied(ktx2Path) {
  const data = fs.readFileSync(ktx2Path);
  data[data.readUInt32LE(48) + DFD_FLAGS_OFFSET] |= DFD_FLAG_ALPHA_PREMULTIPLIED;
  fs.writeFileSync(ktx2Path, data);
}

function astcBytesPerLayer(width, height, astcBlock) {
  const [blockWidth, blockHeight] = astcBlock.split('x').map(Number);
  return Math.ceil(width / blockWidth) * Math.ceil(height / blockHeight) * 16;
}

/**
 * Recompresses a KTX2 file's zstd level data with seek points (see zstd-level.js). toktx only
 * writes one zstd stream.
 */
async function rewriteLevelWithSeekPoints(ktx2Path, { zstdLevel, bytesPerLayer, layersPerSeekPoint }) {
  const data = fs.readFileSync(ktx2Path);
  const levelCount = Math.max(1, data.readUInt32LE(40));
  const levelOffset = Number(data.readBigUInt64LE(80));
  const levelLength = Number(data.readBigUInt64LE(88));
  const uncompressedLength = Number(data.readBigUInt64LE(96));
  if (levelCount !== 1 || levelOffset + levelLength !== data.length) {
    throw new Error('expected one mip level at the end of the KTX2 file');
  }

  const decompressed = spawnSync('zstd', ['-d', '-c', '-q'], {
    input: data.subarray(levelOffset),
    maxBuffer: uncompressedLength + 1024,
  });
  if (decompressed.status !== 0 || decompressed.stdout.length !== uncompressedLength) {
    throw new Error(`zstd could not decompress the level data${decompressed.error ? `: ${decompressed.error.message}` : ''}`);
  }

  const { data: levelData, seekPoints } = await compressLevelData(decompressed.stdout, {
    level: zstdLevel,
    bytesPerLayer,
    layersPerSeekPoint,
    parallel: defaultParallelism(),
  });
  const header = Buffer.from(data.subarray(0, levelOffset));
  header.writeBigUInt64LE(BigInt(levelData.length), 88);
  fs.writeFileSync(ktx2Path, Buffer.concat([header, levelData]));
  return seekPoints;
}

/**
 * Encode frames as a 2D texture array (one frame per layer).
 * Uses toktx --layers to create a single KTX2 with all frames as array layers.
 */
async function encodeTextureArray(opts) {
  const {
    frameFiles,
    frameWidth,
    frameHeight,
    frameRate,
    hasAlpha,
    astcQuality,
    astcBlock,
    astcPerceptual,
    zstdLevel,
    seekInterval,
    outputBase,
    toktxPath,
  } = opts;

  const frameCount = frameFiles.length;
  const bytesPerLayer = astcBytesPerLayer(frameWidth, frameHeight, astcBlock);
  const seekLayers = zstdLevel > 0 ? layersPerSeekPoint(seekInterval, bytesPerLayer) : 0;
  const addSeekPoints = seekLayers > 0 && seekLayers < frameCount;
  if (addSeekPoints) exitUnlessToolFound('zstd', `seek points (clips over --seek-interval ${seekInterval} MB)`);
  const outputDir = path.dirname(outputBase);
  const baseName = path.basename(outputBase);

  console.log(`\n📦 Creating texture array with ${frameCount} layers...`);

  // Optimization: For no-alpha mode, use original PNG files directly
  // This avoids creating intermediate files and saves massive disk space
  let filesToEncode;
  let tempDir = null;
  
  if (!hasAlpha) {
    // No alpha - use original PNG files directly, no processing needed
    console.log('   No alpha mode: using original PNG files directly (no intermediate files)');
    filesToEncode = frameFiles;
  } else {
    // Alpha mode - need to premultiply alpha, requires intermediate files
    // Process in batches to limit disk usage
    tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'texenc-array-'));
    console.log('   Premultiplying alpha on frames...');
    filesToEncode = [];
    
    for (let i = 0; i < frameFiles.length; i++) {
      const inputFile = frameFiles[i];
      const outputFile = path.join(tempDir, `frame_${String(i).padStart(6, '0')}.png`);
      
      // Read image with ensureAlpha
      const rawBuffer = await sharp(inputFile)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      
      const { data, info } = rawBuffer;
      
      // Create new buffer for premultiplied data
      const premultiplied = Buffer.alloc(data.length);
      for (let j = 0; j < data.length; j += 4) {
        const a = data[j + 3] / 255;
        premultiplied[j + 0] = Math.round(data[j + 0] * a);     // R * alpha
        premultiplied[j + 1] = Math.round(data[j + 1] * a);     // G * alpha
        premultiplied[j + 2] = Math.round(data[j + 2] * a);     // B * alpha
        premultiplied[j + 3] = data[j + 3];                      // A unchanged
      }
      
      await sharp(premultiplied, {
        raw: { width: info.width, height: info.height, channels: 4 }
      }).png().toFile(outputFile);
      
      filesToEncode.push(outputFile);
      
      if ((i + 1) % 100 === 0 || i === frameFiles.length - 1) {
        console.log(`   Processed ${i + 1}/${frameFiles.length} frames`);
      }
    }
  }

  try {
    
    const ktx2OutputPath = path.join(outputDir, `${baseName}.ktx2`);

    // Native ASTC encoding with toktx
    // toktx --t2 --encode astc --astc_quality <quality> --astc_blk_d <block> --layers <count> output.ktx2 frame0.png frame1.png ...
    
    const astcArgs = [
      '--t2',                      // Output KTX2 format
      '--encode', 'astc',
      '--astc_blk_d', astcBlock,
      '--astc_quality', astcQuality,
      '--assign_oetf', 'linear',   // Premultiplied alpha requires linear
      '--assign_primaries', 'none', // No color space conversion
      '--layers', frameCount.toString(),
    ];
    if (astcPerceptual) {
      astcArgs.push('--astc_perceptual');
    }

    // KTX2 internal zstd supercompression. With seek points, the level is recompressed at
    // zstdLevel afterwards, so toktx compresses quickly.
    if (zstdLevel > 0) {
      astcArgs.push('--zcmp', addSeekPoints ? '1' : zstdLevel.toString());
    }

    // Add output path
    astcArgs.push(ktx2OutputPath);
    
    // Use @filelist feature for large frame counts to avoid command line limits
    // toktx reads file paths from a text file when prefixed with @
    const fileListPath = path.join(tempDir || require('os').tmpdir(), 'toktx_filelist.txt');
    fs.writeFileSync(fileListPath, filesToEncode.join('\n'));
    astcArgs.push(`@${fileListPath}`);

    console.log(`   Running toktx with ${frameCount} frames (using @filelist)...`);
    console.log(`   This may take a while for large frame counts...`);
    
    try {
      const result = spawnSync(toktxPath, astcArgs, {
        stdio: 'inherit',  // Show progress
        maxBuffer: 500 * 1024 * 1024,
      });
      
      if (result.status !== 0) {
        throw new Error(`toktx exited with code ${result.status}`);
      }
      
      // Cleanup filelist
      fs.unlinkSync(fileListPath);
    } catch (error) {
      console.error(`❌ toktx failed: ${error.message}`);
      try { fs.unlinkSync(fileListPath); } catch (e) {}
      throw error;
    }

    injectKTX2KeyValue(ktx2OutputPath, 'KTXanimData', animDataValue(frameRate));
    if (hasAlpha) markAlphaPremultiplied(ktx2OutputPath);

    let seekPoints = 0;
    if (addSeekPoints) {
      console.log(`   Compressing at zstd level ${zstdLevel} with a seek point every ${seekLayers} frames...`);
      seekPoints = await rewriteLevelWithSeekPoints(ktx2OutputPath, { zstdLevel, bytesPerLayer, layersPerSeekPoint: seekLayers });
    }

    const sizeMB = (fs.statSync(ktx2OutputPath).size / 1024 / 1024).toFixed(2);
    console.log(`\n✅ Texture array created: ${ktx2OutputPath}`);
    console.log(`   Size: ${sizeMB}MB`);
    console.log(`   Layers: ${frameCount}`);
    console.log(`   Frame size: ${frameWidth}x${frameHeight}`);
    if (zstdLevel > 0) {
      console.log(`   Compression: KTX2 internal zstd (supercompressionScheme=2)`);
      console.log(seekPoints > 0 ? `   Seek points: ${seekPoints}` : '   Seek points: none (one zstd stream)');
    } else {
      console.log(`   Compression: None (uncompressed)`);
    }

  } finally {
    // Cleanup temp directory only if we created one
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

program
  .option('-i, --input <directory>', 'Input directory containing PNG frames')
  .option('-v, --video <file>', 'Input video file (extracts frames with ffmpeg, no pre-extraction needed)')
  .requiredOption('-o, --output <path>', 'Output path (written as .ktx2)')
  .option('-w, --width <pixels>', 'Frame width (auto-detected from input if not specified)')
  .option('-h, --height <pixels>', 'Frame height (auto-detected from input if not specified)')
  .option('-f, --fps <rate>', 'Frame rate: 30, 29.97 or 30000/1001 (default: the video\'s, else 30)')
  .option('--frame-count <number>', 'Number of frames to extract from video (required with --video)')
  .option('--astc-quality <level>', 'ASTC quality: fastest, fast, medium, thorough, exhaustive', 'thorough')
  .option('--astc-block <size>', 'ASTC block size: 4x4, 5x4, 5x5, 6x5, 6x6, 8x5, 8x6, 8x8, 10x5, 10x6, 10x8, 10x10, 12x10, 12x12', '4x4')
  .option('--astc-perceptual', 'Optimize ASTC for perceived quality rather than RMS error (default)')
  .option('--no-astc-perceptual', 'Optimize ASTC for RMS error instead')
  .option('--zstd <level>', 'KTX2 internal Zstandard supercompression level (0-22, higher=smaller, 0=uncompressed)', '18')
  .option('--seek-interval <MB>', 'With zstd: a seek point every <MB> of ASTC, so seeks decode at most that much; 0 = one zstd stream, the smallest file, for clips that only play and loop', '8')
  .option('--toktx <path>', 'Path to toktx binary', 'toktx')
  .option('--no-alpha', 'Disable alpha channel (for opaque content)')
  .option('--use-stream-encoder', 'Use memory-efficient streaming encoder (~50MB RAM per frame, requires astcenc)')
  .option('--astcenc <path>', 'astcenc binary for the stream encoder (default: $ASTCENC, then astcenc on PATH)')
  .option('-y, --yes', 'Non-interactive mode: skip prompts, use defaults (for automated scripts)')
  .addHelpText('after', '\nCommands:\n  texenc doctor [--toktx <path>] [--astcenc <path>]   Check the external tools and exit')
  .parse();

const options = program.opts();

function exitUnlessAstcencFound(astcencPath) {
  if (astcencPath && fs.existsSync(astcencPath)) return;
  console.error(`❌ astcenc not found${astcencPath ? `: ${astcencPath}` : ' (looked at --astcenc, $ASTCENC and PATH)'}`);
  console.error(`   ${INSTALL_HINTS.astcenc}`);
  process.exit(1);
}

async function encodeFrames() {
  console.log('🎨 texenc: frames to an ASTC KTX2 texture array\n');

  let frameWidth = options.width ? parseInt(options.width) : null;
  let frameHeight = options.height ? parseInt(options.height) : null;
  const toktxPath = options.toktx;
  const hasAlpha = options.alpha !== false;
  const astcQuality = options.astcQuality || 'thorough';
  const astcBlock = options.astcBlock || '4x4';
  // Both flags are defined, so commander leaves the value unset unless one is given
  const astcPerceptual = options.astcPerceptual !== false;
  const zstdLevel = options.zstd !== undefined ? parseInt(options.zstd) : 18;
  const seekInterval = parseFloat(options.seekInterval);
  if (!(seekInterval >= 0)) {
    console.error('❌ --seek-interval must be 0 (one stream) or a size in MB');
    process.exit(1);
  }
  
  // Normalize output path - strip any extension, we'll add the correct one later
  const outputExt = path.extname(options.output);
  const outputBase = outputExt ? options.output.slice(0, -outputExt.length) : options.output;

  // Validate stream encoder mode (Node.js - memory efficient)
  // Supports both --video and --input (PNG directory)
  const useStreamEncoder = options.useStreamEncoder === true;
  const astcencPath = resolveAstcenc(options.astcenc);
  
  if (useStreamEncoder) {
    exitUnlessAstcencFound(astcencPath);
  } else {
    exitUnlessToolFound('toktx', 'the default encoder (--use-stream-encoder uses astcenc instead)', toktxPath);
  }

  // Validate input - either --input or --video required
  const videoInput = options.video;
  const inputDir = options.input;
  
  if (!videoInput && !inputDir) {
    console.error('❌ Either --input <directory> or --video <file> is required');
    process.exit(1);
  }
  if (videoInput && inputDir) {
    console.error('❌ Cannot use both --input and --video. Choose one.');
    process.exit(1);
  }

  let frameRate = options.fps ? parseFrameRate(options.fps) : null;
  if (options.fps && !frameRate) {
    console.error(`❌ --fps must be a positive rate such as 30, 29.97 or 30000/1001 (got ${options.fps})`);
    process.exit(1);
  }
  if (!frameRate && videoInput && fs.existsSync(videoInput)) {
    exitUnlessToolFound('ffprobe', '--video input');
    frameRate = probeFrameRate(videoInput);
    if (!frameRate) console.error(`⚠️  Couldn't read the frame rate of ${videoInput}; using 30 (pass --fps to set it)`);
  }
  frameRate = frameRate || parseFrameRate(30);

  let frameFiles = [];
  let videoTempDir = null;
  
  if (videoInput) {
    // Video input mode - extract frames with ffmpeg
    if (!fs.existsSync(videoInput)) {
      console.error(`❌ Video file not found: ${videoInput}`);
      process.exit(1);
    }
    exitUnlessToolFound('ffmpeg', '--video input');
    exitUnlessToolFound('ffprobe', '--video input');
    
    const frameCount = options.frameCount ? parseInt(options.frameCount) : null;
    if (!frameCount) {
      console.error('❌ --frame-count is required when using --video');
      console.error('   Use ffprobe to get frame count: ffprobe -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 <video>');
      process.exit(1);
    }
    
    // Auto-detect video dimensions with ffprobe if width/height not provided (or -1)
    if (!frameWidth || !frameHeight || frameWidth === -1 || frameHeight === -1) {
      try {
        const probeCmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${videoInput}"`;
        const dimensions = execSync(probeCmd, { encoding: 'utf8' }).trim().split(',');
        const srcWidth = parseInt(dimensions[0]);
        const srcHeight = parseInt(dimensions[1]);
        
        if ((!frameWidth || frameWidth === -1) && (!frameHeight || frameHeight === -1)) {
          // Both unset: use original dimensions
          frameWidth = srcWidth;
          frameHeight = srcHeight;
        } else if (!frameWidth || frameWidth === -1) {
          // Width unset: calculate from height preserving aspect ratio
          frameWidth = Math.round(srcWidth * (frameHeight / srcHeight));
          frameWidth = frameWidth % 2 === 0 ? frameWidth : frameWidth + 1;
        } else {
          // Height unset: calculate from width preserving aspect ratio
          frameHeight = Math.round(srcHeight * (frameWidth / srcWidth));
          frameHeight = frameHeight % 2 === 0 ? frameHeight : frameHeight + 1;
        }
        console.log(`📐 Auto-detected dimensions: ${frameWidth}x${frameHeight}`);
      } catch (error) {
        console.error(`❌ Failed to get video dimensions: ${error.message}`);
        process.exit(1);
      }
    }
    
    // Use memory-efficient stream encoder (Node.js + astcenc, ~50MB RAM per frame)
    if (useStreamEncoder) {
      console.log(`🚀 Using memory-efficient stream encoder (~50MB RAM per frame)`);
      console.log(`   Source: ${videoInput}`);
      console.log(`   Dimensions: ${frameWidth}x${frameHeight}`);
      console.log(`   Frames: ${frameCount}`);
      console.log(`   ASTC block: ${astcBlock}, quality: ${astcQuality}`);
      
      const ktx2OutputPath = `${outputBase}.ktx2`;
      
      // Call the stream encoder script
      const streamArgs = [
        path.join(__dirname, 'texenc-stream.js'),
        '--video', videoInput,
        '--output', ktx2OutputPath,
        '--width', frameWidth.toString(),
        '--height', frameHeight.toString(),
        '--frames', frameCount.toString(),
        '--fps', `${frameRate.timescale}/${frameRate.duration}`,
        '--block', astcBlock,
        '--quality', astcQuality,
        '--astcenc', astcencPath,
      ];
      if (!astcPerceptual) {
        streamArgs.push('--no-perceptual');
      }
      
      if (zstdLevel > 0) {
        streamArgs.push('--zstd', zstdLevel.toString(), '--seek-interval', seekInterval.toString());
      }

      if (hasAlpha) {
        streamArgs.push('--alpha');
      }
      
      console.log(`\n📦 Encoding ${frameCount} frames to KTX2...`);
      
      try {
        const result = spawnSync(process.execPath, streamArgs, {
          stdio: 'inherit',
        });
        
        if (result.status !== 0) {
          throw new Error(`Stream encoder exited with code ${result.status}`);
        }
        
        const stats = fs.statSync(ktx2OutputPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        
        console.log(`\n✅ Done! Output: ${ktx2OutputPath} (${sizeMB}MB)${zstdLevel > 0 ? ' [KTX2 internal zstd]' : ''}`);
        
        return;  // Exit early
        
      } catch (error) {
        console.error(`❌ Stream encoder failed: ${error.message}`);
        process.exit(1);
      }
    }
    
    // Standard mode: extract frames to temp directory
    console.log(`🎬 Extracting ${frameCount} frames from video...`);
    console.log(`   Source: ${videoInput}`);
    
    // Create temp directory for extracted frames
    videoTempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'texenc-video-'));
    
    // Extract frames with ffmpeg
    // Using PNG format for lossless extraction
    const ffmpegCmd = `ffmpeg -i "${videoInput}" -vf "scale=${frameWidth}:${frameHeight}" -frames:v ${frameCount} "${path.join(videoTempDir, 'frame_%06d.png')}"`;
    
    try {
      console.log(`   Running ffmpeg...`);
      execSync(ffmpegCmd, { stdio: 'inherit' });
    } catch (error) {
      console.error(`❌ ffmpeg failed: ${error.message}`);
      fs.rmSync(videoTempDir, { recursive: true, force: true });
      process.exit(1);
    }
    
    // Get extracted frame files
    frameFiles = fs.readdirSync(videoTempDir)
      .filter(f => f.toLowerCase().endsWith('.png'))
      .sort()
      .map(f => path.join(videoTempDir, f));
    
    console.log(`   ✓ Extracted ${frameFiles.length} frames`);
    
  } else {
    // Directory input mode
    if (!fs.existsSync(inputDir)) {
      console.error(`❌ Input directory not found: ${inputDir}`);
      process.exit(1);
    }

    frameFiles = fs.readdirSync(inputDir)
      .filter(f => f.toLowerCase().endsWith('.png'))
      .sort()
      .map(f => path.join(inputDir, f));

    if (frameFiles.length === 0) {
      console.error(`❌ No PNG frames found in: ${inputDir}`);
      process.exit(1);
    }
  }

  // Auto-detect frame dimensions from first frame if not provided
  if (!frameWidth || !frameHeight) {
    try {
      const firstFrameMeta = await sharp(frameFiles[0]).metadata();
      if (!frameWidth) frameWidth = firstFrameMeta.width;
      if (!frameHeight) frameHeight = firstFrameMeta.height;
      console.log(`📐 Auto-detected dimensions: ${frameWidth}x${frameHeight}`);
    } catch (error) {
      console.error(`❌ Failed to read frame dimensions from ${frameFiles[0]}: ${error.message}`);
      console.error('   Specify dimensions manually with -w <width> -h <height>');
      process.exit(1);
    }
  }

  console.log(`📁 Found ${frameFiles.length} PNG frames`);
  console.log(`📐 Frame size: ${frameWidth}x${frameHeight}`);
  console.log(`🎬 Frame rate: ${formatFrameRate(frameRate)} fps`);
  console.log(`🔲 Alpha: ${hasAlpha ? 'Yes' : 'No'}`);
  console.log(`🎯 ASTC block=${astcBlock}, quality=${astcQuality}${astcPerceptual ? ', perceptual' : ''}`);
  if (zstdLevel > 0) {
    console.log(`🗜️  Zstd compression: level ${zstdLevel} (KTX2 internal)`);
  } else {
    console.log(`🗜️  Zstd compression: disabled`);
  }

  const pixelsPerFrame = frameWidth * frameHeight;
  const channels = hasAlpha ? 4 : 3;
  const rawFrameSizeBytes = pixelsPerFrame * channels;
  const totalRawSizeGB = (rawFrameSizeBytes * frameFiles.length) / (1024 * 1024 * 1024);
  
  // ASTC 4x4 = 8 bits/pixel (1 byte), 6x6 = ~3.56 bits/pixel, etc.
  const astcBitsPerPixel = {
    '4x4': 8, '5x4': 6.4, '5x5': 5.12, '6x5': 4.27, '6x6': 3.56,
    '8x5': 3.2, '8x6': 2.67, '8x8': 2, '10x5': 2.56, '10x6': 2.13,
    '10x8': 1.6, '10x10': 1.28, '12x10': 1.07, '12x12': 0.89
  };
  const bpp = astcBitsPerPixel[astcBlock] || 8;
  const astcFrameSizeBytes = (pixelsPerFrame * bpp) / 8;
  const estimatedOutputGB = (astcFrameSizeBytes * frameFiles.length) / (1024 * 1024 * 1024);
  
  // Intermediate files only needed for alpha mode
  const intermediateGB = hasAlpha ? totalRawSizeGB * 0.3 : 0; // PNG compression ~30% of raw
  
  console.log(`\n📊 Disk space estimates:`);
  console.log(`   Raw pixel data: ~${totalRawSizeGB.toFixed(2)}GB (uncompressed RGB/RGBA)`);
  if (hasAlpha) {
    console.log(`   Intermediate files: ~${intermediateGB.toFixed(2)}GB (alpha premultiply)`);
  } else {
    console.log(`   Intermediate files: 0GB (no-alpha optimization)`);
  }
  console.log(`   Output KTX2 (ASTC data): ~${estimatedOutputGB.toFixed(2)}GB`);
  if (zstdLevel > 0) {
    const compressedGB = estimatedOutputGB * 0.5; // Rough estimate: 50% compression
    console.log(`   Output KTX2 (with internal zstd): ~${compressedGB.toFixed(2)}GB`);
  }
  console.log(`   Peak disk usage: ~${(estimatedOutputGB + intermediateGB).toFixed(2)}GB`);
  
  // Recommend stream encoder for large frame counts or high resolution
  const pixelCount = frameWidth * frameHeight;
  const frameCount = frameFiles.length;
  const shouldRecommendStreamEncoder = (frameCount > 200 || pixelCount > 2073600); // >200 frames or >1080p
  
  if (shouldRecommendStreamEncoder && !options.useStreamEncoder && !options.yes) {
    console.log(`\n💡 Recommendation: Use the memory-efficient stream encoder`);
    console.log(`   Your encoding has ${frameCount} frames at ${frameWidth}x${frameHeight} resolution.`);
    console.log(`   The default encoder (toktx) loads all frames into memory at once.`);
    console.log(`   The stream encoder uses constant ~50MB RAM regardless of frame count.`);
    console.log(`   Requires: astcenc (ARM ASTC Encoder)`);
    console.log(`   Install: Download from https://github.com/ARM-software/astc-encoder/releases`);
    console.log(`   Use --use-stream-encoder to enable, or --yes to skip this prompt.\n`);
    
    // Interactive prompt
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    
    const answer = await new Promise((resolve) => {
      rl.question('Use stream encoder? [y/N]: ', (ans) => {
        rl.close();
        resolve(ans.toLowerCase().trim());
      });
    });
    
    if (answer === 'y' || answer === 'yes') {
      options.useStreamEncoder = true;
      console.log('✓ Using stream encoder\n');
    }
  }
  console.log();

  // Check if user wants to use stream encoder (for PNG input)
  if (options.useStreamEncoder) {
    exitUnlessAstcencFound(astcencPath);
    
    console.log(`🚀 Using memory-efficient stream encoder (~50MB RAM per frame)`);
    console.log(`   Source: ${inputDir}`);
    console.log(`   Dimensions: ${frameWidth}x${frameHeight}`);
    console.log(`   Frames: ${frameFiles.length}`);
    console.log(`   ASTC block: ${astcBlock}, quality: ${astcQuality}`);
    
    const ktx2OutputPath = `${outputBase}.ktx2`;
    
    // Call the stream encoder script with PNG input
    const streamArgs = [
      path.join(__dirname, 'texenc-stream.js'),
      '--input', inputDir,
      '--output', ktx2OutputPath,
      '--fps', `${frameRate.timescale}/${frameRate.duration}`,
      '--block', astcBlock,
      '--quality', astcQuality,
      '--astcenc', astcencPath,
    ];
    if (!astcPerceptual) {
      streamArgs.push('--no-perceptual');
    }
    
    if (zstdLevel > 0) {
      streamArgs.push('--zstd', zstdLevel.toString(), '--seek-interval', seekInterval.toString());
    }
    
    // Pass alpha flag for premultiplication
    if (hasAlpha) {
      streamArgs.push('--alpha');
    }
    
    console.log(`\n📦 Encoding ${frameFiles.length} frames to KTX2...`);
    
    try {
      const result = spawnSync(process.execPath, streamArgs, {
        stdio: 'inherit',
      });
      
      if (result.status !== 0) {
        throw new Error(`Stream encoder exited with code ${result.status}`);
      }
      
      const stats = fs.statSync(ktx2OutputPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      
      console.log(`\n✅ Done! Output: ${ktx2OutputPath} (${sizeMB}MB)${zstdLevel > 0 ? ' [KTX2 internal zstd]' : ''}`);
      
      return;
    } catch (error) {
      console.error(`❌ Stream encoder failed: ${error.message}`);
      process.exit(1);
    }
  }
  
  // Texture array mode - each frame is a separate layer in a 2D texture array
  try {
    await encodeTextureArray({
      frameFiles,
      frameWidth,
      frameHeight,
      frameRate,
      hasAlpha,
      astcQuality,
      astcBlock,
      astcPerceptual,
      zstdLevel,
      seekInterval,
      outputBase,
      toktxPath,
    });
  } finally {
    // Cleanup video temp directory if we created one
    if (videoTempDir) {
      console.log('   Cleaning up extracted frames...');
      fs.rmSync(videoTempDir, { recursive: true, force: true });
    }
  }
}

// Run encoder
encodeFrames().catch(error => {
  console.error('\n❌ Encoding failed:', error.message);
  process.exit(1);
});