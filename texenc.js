#!/usr/bin/env node

/**
 * PNG/Video to KTX2 Texture Encoder
 * 
 * Converts PNG frames or video to KTX2 texture files using native ASTC or
 * Basis Universal (UASTC) encoding.
 * 
 * Defaults: texture array packing, streaming mode, KTX2 internal zstd compression.
 * 
 * Prerequisites:
 * - npm install sharp commander
 * - Install toktx (KTX-Software): brew install ktx (macOS)
 *   Or download from: https://github.com/KhronosGroup/KTX-Software/releases
 * 
 * Output:
 *   - Array mode (default): outputs animation.ktx2 (texture array with streaming)
 *   - Atlas mode: outputs animation.ktx2 or animation.glb (GLB container with all parts)
 */

const sharp = require('sharp');
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { program } = require('commander');

/**
 * Package multiple KTX2 files into a GLB container.
 * GLB format: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#glb-file-format-specification
 * 
 * Structure:
 * - 12-byte header: magic (0x46546C67 "glTF"), version (2), total length
 * - JSON chunk: type 0x4E4F534A, contains metadata with KTX2 part info
 * - BIN chunk: type 0x004E4942, contains concatenated KTX2 data
 */
function packageKTX2ToGLB(ktx2Files, metadata, outputPath) {
  // Read all KTX2 files
  const ktx2Buffers = ktx2Files.map(file => fs.readFileSync(file));
  
  // Calculate offsets for each KTX2 part in the BIN chunk
  let currentOffset = 0;
  const partOffsets = [];
  for (const buffer of ktx2Buffers) {
    partOffsets.push({
      byteOffset: currentOffset,
      byteLength: buffer.length
    });
    currentOffset += buffer.length;
  }
  
  // Update metadata with GLB-specific info
  const glbMetadata = {
    ...metadata,
    container: 'glb',
    ktx2Parts: partOffsets.map((offset, i) => ({
      ...metadata.parts[i],
      byteOffset: offset.byteOffset,
      byteLength: offset.byteLength
    }))
  };
  
  // Create JSON chunk (must be padded to 4-byte alignment with spaces)
  const jsonString = JSON.stringify(glbMetadata);
  const jsonPadding = (4 - (jsonString.length % 4)) % 4;
  const jsonChunkData = Buffer.from(jsonString + ' '.repeat(jsonPadding), 'utf8');
  const jsonChunkLength = jsonChunkData.length;
  
  // Create BIN chunk (must be padded to 4-byte alignment with zeros)
  const binDataLength = ktx2Buffers.reduce((sum, buf) => sum + buf.length, 0);
  const binPadding = (4 - (binDataLength % 4)) % 4;
  const binChunkLength = binDataLength + binPadding;
  
  // Calculate total GLB size
  const headerSize = 12;
  const jsonChunkHeaderSize = 8;
  const binChunkHeaderSize = 8;
  const totalSize = headerSize + jsonChunkHeaderSize + jsonChunkLength + binChunkHeaderSize + binChunkLength;
  
  // Create GLB buffer
  const glb = Buffer.alloc(totalSize);
  let offset = 0;
  
  // Write GLB header
  glb.writeUInt32LE(0x46546C67, offset); // magic "glTF"
  offset += 4;
  glb.writeUInt32LE(2, offset); // version
  offset += 4;
  glb.writeUInt32LE(totalSize, offset); // total length
  offset += 4;
  
  // Write JSON chunk header
  glb.writeUInt32LE(jsonChunkLength, offset); // chunk length
  offset += 4;
  glb.writeUInt32LE(0x4E4F534A, offset); // chunk type "JSON"
  offset += 4;
  
  // Write JSON chunk data
  jsonChunkData.copy(glb, offset);
  offset += jsonChunkLength;
  
  // Write BIN chunk header
  glb.writeUInt32LE(binChunkLength, offset); // chunk length
  offset += 4;
  glb.writeUInt32LE(0x004E4942, offset); // chunk type "BIN\0"
  offset += 4;
  
  // Write BIN chunk data (concatenated KTX2 files)
  for (const buffer of ktx2Buffers) {
    buffer.copy(glb, offset);
    offset += buffer.length;
  }
  // Padding is already zeros from Buffer.alloc
  
  fs.writeFileSync(outputPath, glb);
  console.log(`   ✓ Created GLB container: ${outputPath} (${(glb.length / 1024 / 1024).toFixed(2)}MB)`);
  
  return glb.length;
}

/**
 * Inject custom metadata into a KTX2 file's key-value data section.
 * KTX2 format: https://github.khronos.org/KTX-Specification/
 */
function injectKTX2Metadata(ktx2Path, key, value) {
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
  
  // Create new key-value entry
  // Format: keyAndValueByteLength (uint32) + key (NUL-terminated) + value (NUL-terminated) + padding
  const keyBytes = Buffer.from(key + '\0', 'utf8');
  const valueBytes = Buffer.from(value + '\0', 'utf8');
  const kvEntryLength = keyBytes.length + valueBytes.length;
  const kvEntryPadding = (4 - (kvEntryLength % 4)) % 4;
  const kvEntryTotalLength = 4 + kvEntryLength + kvEntryPadding; // 4 bytes for length prefix
  
  // New KVD section = old KVD + new entry
  const newKvdByteLength = kvdByteLength + kvEntryTotalLength;
  const kvdLengthDiff = newKvdByteLength - kvdByteLength;
  
  // Calculate padding difference (KVD must be aligned to 4 bytes, SGD to 8 bytes)
  const oldKvdEnd = kvdByteOffset + kvdByteLength;
  const newKvdEnd = kvdByteOffset + newKvdByteLength;
  
  // SGD padding (align to 8 bytes)
  const oldSgdPadding = sgdByteLength > 0 ? (8 - (oldKvdEnd % 8)) % 8 : 0;
  const newSgdPadding = sgdByteLength > 0 ? (8 - (newKvdEnd % 8)) % 8 : 0;
  
  // Level data starts after SGD (or after KVD if no SGD)
  const oldLevelDataStart = sgdByteLength > 0 ? sgdByteOffset + sgdByteLength : oldKvdEnd + oldSgdPadding;
  const levelDataOffset = kvdLengthDiff + (newSgdPadding - oldSgdPadding);
  
  // Build new file
  const newSize = data.length + kvEntryTotalLength + (newSgdPadding - oldSgdPadding);
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
  
  // Add new entry
  const newEntryBuffer = Buffer.alloc(kvEntryTotalLength);
  const newEntryView = new DataView(newEntryBuffer.buffer);
  newEntryView.setUint32(0, kvEntryLength, true);
  keyBytes.copy(newEntryBuffer, 4);
  valueBytes.copy(newEntryBuffer, 4 + keyBytes.length);
  
  existingEntries.push({
    key: key,
    data: newEntryBuffer
  });
  
  // Sort entries by key (KTX2 requirement)
  existingEntries.sort((a, b) => a.key.localeCompare(b.key));
  
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
  const levelDataLength = data.length - oldLevelDataStart;
  data.copy(newData, writePos, oldLevelDataStart, data.length);
  
  fs.writeFileSync(ktx2Path, newData);
  console.log(`   ✓ Injected metadata key "${key}" (${value.length} bytes)`);
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
    useASTC,
    useUASTC,
    uastcRdo,
    uastcLevel,
    astcQuality,
    astcBlock,
    zstdLevel,
    outputBase,
    toktxPath,
    useInnerCompression,
  } = opts;

  const frameCount = frameFiles.length;
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
    tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'basis-array-'));
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

    if (useASTC) {
      // Native ASTC encoding with toktx
      // toktx --t2 --encode astc --astc_quality <quality> --astc_blk_d <block> --layers <count> output.ktx2 frame0.png frame1.png ...
      
      const astcArgs = [
        '--t2',                      // Output KTX2 format
        '--encode', 'astc',
        '--astc_blk_d', astcBlock,
        '--astc_quality', astcQuality,
        '--astc_perceptual',         // Perceptual optimization for better quality
        '--assign_oetf', 'linear',   // Premultiplied alpha requires linear
        '--assign_primaries', 'none', // No color space conversion
        '--layers', frameCount.toString(),
      ];

      // Compression: use toktx internal zstd (--zcmp) unless --outer-compression is specified
      if (zstdLevel > 0 && useInnerCompression) {
        astcArgs.push('--zcmp', zstdLevel.toString());
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

    } else if (useUASTC) {
      // UASTC encoding with toktx
      const uastcArgs = [
        '--t2',                      // Output KTX2 format
        '--encode', 'uastc',
        '--assign_oetf', 'linear',   // Treat input as linear for correct colors
        '--assign_primaries', 'none', // No color space conversion
        '--layers', frameCount.toString(),
      ];

      // Compression: use toktx internal zstd (--zcmp) unless --outer-compression is specified
      if (zstdLevel > 0 && useInnerCompression) {
        uastcArgs.push('--zcmp', zstdLevel.toString());
      }

      if (uastcRdo > 0) {
        uastcArgs.push('--uastc_rdo_l', uastcRdo.toString());
      }

      uastcArgs.push(ktx2OutputPath);
      
      // Use @filelist feature for large frame counts
      const fileListPath = path.join(tempDir || require('os').tmpdir(), 'toktx_filelist.txt');
      fs.writeFileSync(fileListPath, filesToEncode.join('\n'));
      uastcArgs.push(`@${fileListPath}`);

      console.log(`   Running toktx with ${frameCount} frames (using @filelist)...`);
      console.log(`   This may take a while for large frame counts...`);

      try {
        const result = spawnSync(toktxPath, uastcArgs, {
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
    }

    // Get output file size
    const stats = fs.statSync(ktx2OutputPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    // Create and inject metadata
    const metadata = {
      version: 1,
      type: 'BasisPlayerMetadata',
      packingMode: 'array',
      frameCount,
      frameRate,
      frameWidth,
      frameHeight,
      hasAlpha,
      premultipliedAlpha: hasAlpha,  // Always premultiply when alpha is enabled
      mode: useASTC ? 'astc' : 'uastc',
      layerCount: frameCount,
    };

    injectKTX2Metadata(ktx2OutputPath, 'BasisPlayerMetadata', JSON.stringify(metadata));

    // Compression strategy:
    // - With inner compression (default): already compressed via toktx --zcmp, output .ktx2
    // - With outer compression: compress entire KTX2 externally, output .ktx2.zst
    // - If zstdLevel is 0: no compression
    let finalOutputPath = ktx2OutputPath;
    let finalSizeMB = sizeMB;
    
    if (zstdLevel > 0 && !useInnerCompression) {
      // External compression (outer .zst wrapper)
      const zstdOutputPath = ktx2OutputPath + '.zst';
      console.log(`\n🗜️  Applying outer zstd compression (level ${zstdLevel})...`);
      
      try {
        execSync(`zstd -${zstdLevel} -f "${ktx2OutputPath}" -o "${zstdOutputPath}"`, { stdio: 'pipe' });
        
        const zstdStats = fs.statSync(zstdOutputPath);
        finalSizeMB = (zstdStats.size / 1024 / 1024).toFixed(2);
        const compressionRatio = (stats.size / zstdStats.size).toFixed(2);
        
        fs.unlinkSync(ktx2OutputPath);
        finalOutputPath = zstdOutputPath;
        console.log(`   Compressed: ${sizeMB}MB → ${finalSizeMB}MB (${compressionRatio}x)`);
      } catch (error) {
        console.error(`❌ zstd compression failed: ${error.message}`);
        console.error('   Make sure zstd is installed: brew install zstd (macOS) or apt install zstd (Linux)');
        throw error;
      }
    }

    console.log(`\n✅ Texture array created: ${finalOutputPath}`);
    console.log(`   Size: ${finalSizeMB}MB`);
    console.log(`   Layers: ${frameCount}`);
    console.log(`   Frame size: ${frameWidth}x${frameHeight}`);
    if (zstdLevel > 0 && useInnerCompression) {
      console.log(`   Compression: KTX2 internal zstd (supercompressionScheme=2)`);
    } else if (zstdLevel > 0) {
      console.log(`   Compression: External .zst wrapper`);
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
  .requiredOption('-o, --output <path>', 'Output path (extension auto-determined: .ktx2 for single, .glb for multi-part)')
  .option('-w, --width <pixels>', 'Frame width (auto-detected from input if not specified)')
  .option('-h, --height <pixels>', 'Frame height (auto-detected from input if not specified)')
  .option('-f, --fps <number>', 'Frame rate', '30')
  .option('--frame-count <number>', 'Number of frames to extract from video (required with --video)')
  .option('--uastc', 'Use UASTC mode instead of ASTC (Basis Universal - transcodes to any format at runtime)')
  .option('--uastc-rdo <lambda>', 'UASTC RDO quality (0.25=high quality, 3.0=smaller file)', '')
  .option('--uastc-level <0-4>', 'UASTC encoding level (0=fastest, 4=best quality)', '4')
  .option('--astc', 'Use native ASTC encoding (default, higher quality, requires ASTC-capable device)')
  .option('--astc-quality <level>', 'ASTC quality: fastest, fast, medium, thorough, exhaustive', 'thorough')
  .option('--astc-block <size>', 'ASTC block size: 4x4, 5x4, 5x5, 6x5, 6x6, 8x5, 8x6, 8x8, 10x5, 10x6, 10x8, 10x10, 12x10, 12x12', '4x4')
  .option('--astc-perceptual', 'Optimize ASTC for perceptual quality (may reduce visible artifacts)')
  .option('--zstd <level>', 'Zstandard compression level for ASTC (0-22, higher=smaller)', '18')
  .option('--toktx <path>', 'Path to toktx binary', 'toktx')
  .option('--max-texture-size <pixels>', 'Maximum texture size before splitting into multiple parts', '8192')
  .option('--no-alpha', 'Disable alpha channel (for opaque content)')
  .option('--keep-atlas', 'Keep intermediate atlas PNG file (saves to output directory)')
  .option('--no-glb', 'Disable GLB container for multi-part (output separate KTX2 files instead)')
  .option('--json-metadata', 'Output separate JSON metadata file (in addition to embedded metadata)')
  .option('--mode <type>', 'Packing mode: array (default, texture array, 1 frame per layer) or atlas (frames in grid)', 'array')
  .option('--outer-compression', 'Use outer .zst wrapper instead of KTX2 internal zstd supercompression')
  .option('--use-stream-encoder', 'Use memory-efficient streaming encoder (~50MB RAM per frame, requires astcenc)')
  .option('--astcenc <path>', 'Path to astcenc binary (for stream encoder)', './astcenc-sdk/bin/astcenc')
  .option('-y, --yes', 'Non-interactive mode: skip prompts, use defaults (for automated scripts)')
  .parse();

const options = program.opts();

async function encodePNGFramesToBasis() {
  console.log('🎨 PNG to Basis Universal Atlas Encoder\n');

  let frameWidth = options.width ? parseInt(options.width) : null;
  let frameHeight = options.height ? parseInt(options.height) : null;
  const frameRate = parseFloat(options.fps);
  const toktxPath = options.toktx;
  const hasAlpha = options.alpha !== false;
  const useUASTC = options.uastc === true;
  const useASTC = useUASTC ? false : true;  // ASTC is default unless --uastc is specified
  const uastcRdo = options.uastcRdo ? parseFloat(options.uastcRdo) : 0;
  const uastcLevel = parseInt(options.uastcLevel) || 4;
  const astcQuality = options.astcQuality || 'thorough';
  const astcBlock = options.astcBlock || '4x4';
  const zstdLevel = options.zstd !== undefined ? parseInt(options.zstd) : 18;
  const maxTextureSize = parseInt(options.maxTextureSize);
  const packingMode = options.mode || 'array';
  const useInnerCompression = options.outerCompression !== true;
  
  // Normalize output path - strip any extension, we'll add the correct one later
  const outputExt = path.extname(options.output);
  const outputBase = outputExt ? options.output.slice(0, -outputExt.length) : options.output;

  // Validate packing mode
  if (packingMode !== 'atlas' && packingMode !== 'array') {
    console.error(`❌ Invalid packing mode: ${packingMode}. Use 'atlas' or 'array'.`);
    process.exit(1);
  }

  // Validate stream encoder mode (Node.js - memory efficient)
  // Supports both --video and --input (PNG directory)
  const useStreamEncoder = options.useStreamEncoder === true;
  const astcencPath = options.astcenc || './astcenc-sdk/bin/astcenc';
  
  if (useStreamEncoder) {
    if (packingMode !== 'array') {
      console.error('❌ --use-stream-encoder requires --mode array');
      process.exit(1);
    }
    if (useUASTC) {
      console.error('❌ --use-stream-encoder currently only supports ASTC mode (not --uastc)');
      process.exit(1);
    }
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

  let frameFiles = [];
  let videoTempDir = null;
  
  if (videoInput) {
    // Video input mode - extract frames with ffmpeg
    if (!fs.existsSync(videoInput)) {
      console.error(`❌ Video file not found: ${videoInput}`);
      process.exit(1);
    }
    
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
        '--block', astcBlock,
        '--quality', astcQuality,
        '--astcenc', astcencPath,
      ];
      
      // Pass compression flags to stream encoder
      if (zstdLevel > 0) {
        streamArgs.push('--zstd', zstdLevel.toString());
        if (useInnerCompression) {
          streamArgs.push('--inner-compression');
        }
      }
      
      console.log(`\n📦 Encoding ${frameCount} frames to KTX2...`);
      
      try {
        const result = spawnSync(process.execPath, streamArgs, {
          stdio: 'inherit',
        });
        
        if (result.status !== 0) {
          throw new Error(`Stream encoder exited with code ${result.status}`);
        }
        
        // Inject metadata
        console.log('\n📝 Injecting metadata...');
        const metadata = {
          version: 1,
          frameRate: frameRate,
          frameWidth: frameWidth,
          frameHeight: frameHeight,
          frameCount: frameCount,
          hasAlpha: hasAlpha,
          premultipliedAlpha: hasAlpha,  // Stream encoder always premultiplies when alpha is enabled
          mode: 'astc',
          packingMode: 'array',  // Required for player to recognize texture array
          layerCount: frameCount,
        };
        
        injectKTX2Metadata(ktx2OutputPath, 'BasisPlayerMetadata', JSON.stringify(metadata));
        
        // Stream encoder handles compression internally when --inner-compression is passed
        // Only show final output info here
        const stats = fs.statSync(ktx2OutputPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        
        if (useInnerCompression && zstdLevel > 0) {
          console.log(`\n✅ Done! Output: ${ktx2OutputPath} (${sizeMB}MB) [KTX2 internal zstd]`);
        } else if (zstdLevel > 0) {
          // Stream encoder created .ktx2.zst file
          const zstdOutputPath = ktx2OutputPath + '.zst';
          if (fs.existsSync(zstdOutputPath)) {
            const zstdStats = fs.statSync(zstdOutputPath);
            const zstdSizeMB = (zstdStats.size / 1024 / 1024).toFixed(2);
            console.log(`\n✅ Done! Output: ${zstdOutputPath} (${zstdSizeMB}MB)`);
          } else {
            console.log(`\n✅ Done! Output: ${ktx2OutputPath} (${sizeMB}MB)`);
          }
        } else {
          console.log(`\n✅ Done! Output: ${ktx2OutputPath} (${sizeMB}MB)`);
        }
        
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
    videoTempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'basis-video-'));
    
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
  console.log(`🎬 Frame rate: ${frameRate} fps`);
  console.log(`🔲 Alpha: ${hasAlpha ? 'Yes' : 'No'}`);
  if (useASTC) {
    console.log(`🎯 Mode: Native ASTC (block=${astcBlock}, quality=${astcQuality})`);
    if (zstdLevel > 0) {
      console.log(`🗜️  Zstd compression: level ${zstdLevel} (${useInnerCompression ? 'KTX2 internal' : 'external .zst'})`);
    } else {
      console.log(`🗜️  Zstd compression: disabled`);
    }
  } else {
    console.log(`🎯 Mode: UASTC ${uastcRdo > 0 ? `+ RDO (lambda=${uastcRdo})` : `(level=${uastcLevel})`}`);
  }
  console.log(`📦 Packing: ${packingMode === 'atlas' ? 'Atlas (2D grid)' : 'Texture Array (1 frame per layer)'}`);

  // Estimate disk space requirements for texture array mode
  if (packingMode === 'array') {
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
      if (useInnerCompression) {
        console.log(`   Output KTX2 (with internal zstd): ~${compressedGB.toFixed(2)}GB`);
      } else {
        console.log(`   Output KTX2.zst (external zstd wrapper): ~${compressedGB.toFixed(2)}GB`);
      }
    }
    console.log(`   Peak disk usage: ~${(estimatedOutputGB + intermediateGB).toFixed(2)}GB`);
    
    // Recommend stream encoder for large frame counts or high resolution
    const pixelCount = frameWidth * frameHeight;
    const frameCount = frameFiles.length;
    const shouldRecommendStreamEncoder = useASTC && (frameCount > 200 || pixelCount > 2073600); // >200 frames or >1080p
    
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
  }
  console.log();

  // Handle different packing modes
  if (packingMode === 'array') {
    // Check if user wants to use stream encoder (for PNG input)
    if (options.useStreamEncoder && useASTC) {
      const astcencPath = options.astcenc;
      
      // Check if astcenc exists
      if (!fs.existsSync(astcencPath)) {
        console.error(`❌ astcenc not found: ${astcencPath}`);
        console.error('   Download from: https://github.com/ARM-software/astc-encoder/releases');
        console.error('   Or specify path with --astcenc <path>');
        process.exit(1);
      }
      
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
        '--block', astcBlock,
        '--quality', astcQuality,
        '--astcenc', astcencPath,
      ];
      
      // Pass compression flags to stream encoder
      if (zstdLevel > 0) {
        streamArgs.push('--zstd', zstdLevel.toString());
        if (useInnerCompression) {
          streamArgs.push('--inner-compression');
        }
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
        
        // Inject metadata
        console.log('\n📝 Injecting metadata...');
        const metadata = {
          version: 1,
          frameRate: frameRate,
          frameWidth: frameWidth,
          frameHeight: frameHeight,
          frameCount: frameFiles.length,
          hasAlpha: hasAlpha,
          premultipliedAlpha: hasAlpha,  // Stream encoder always premultiplies when alpha is enabled
          mode: 'astc',
          packingMode: 'array',
          layerCount: frameFiles.length,
        };
        
        injectKTX2Metadata(ktx2OutputPath, 'BasisPlayerMetadata', JSON.stringify(metadata));
        
        const stats = fs.statSync(ktx2OutputPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        
        if (useInnerCompression && zstdLevel > 0) {
          console.log(`\n✅ Done! Output: ${ktx2OutputPath} (${sizeMB}MB) [KTX2 internal zstd]`);
        } else if (zstdLevel > 0) {
          const zstdOutputPath = ktx2OutputPath + '.zst';
          if (fs.existsSync(zstdOutputPath)) {
            const zstdStats = fs.statSync(zstdOutputPath);
            const zstdSizeMB = (zstdStats.size / 1024 / 1024).toFixed(2);
            console.log(`\n✅ Done! Output: ${zstdOutputPath} (${zstdSizeMB}MB)`);
          } else {
            console.log(`\n✅ Done! Output: ${ktx2OutputPath} (${sizeMB}MB)`);
          }
        } else {
          console.log(`\n✅ Done! Output: ${ktx2OutputPath} (${sizeMB}MB)`);
        }
        
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
        useASTC,
        useUASTC,
        uastcRdo,
        uastcLevel,
        astcQuality,
        astcBlock,
        zstdLevel,
        outputBase,
        toktxPath,
        useInnerCompression,
      });
    } finally {
      // Cleanup video temp directory if we created one
      if (videoTempDir) {
        console.log('   Cleaning up extracted frames...');
        fs.rmSync(videoTempDir, { recursive: true, force: true });
      }
    }
    return;
  }

  // Atlas mode - calculate 2D grid dimensions for optimal packing
  const frameCount = frameFiles.length;
  const maxTextureHeight = maxTextureSize; // Use same limit for height
  
  // Calculate how many frames fit in one part using 2D grid
  const framesPerRow = Math.floor(maxTextureSize / frameWidth);
  const maxRowsPerPart = Math.floor(maxTextureHeight / frameHeight);
  const framesPerPart = framesPerRow * maxRowsPerPart;
  
  const partCount = Math.ceil(frameCount / framesPerPart);
  
  console.log(`📐 2D Grid calculation:`);
  console.log(`   Max texture size: ${maxTextureSize}x${maxTextureHeight}`);
  console.log(`   Frames per row: ${framesPerRow}`);
  console.log(`   Max rows per part: ${maxRowsPerPart}`);
  console.log(`   Frames per part: ${framesPerPart}`);
  
  // Calculate actual dimensions for a full part
  const partWidth = framesPerRow * frameWidth;
  const partHeight = maxRowsPerPart * frameHeight;
  
  const atlasWidth = partWidth;
  const atlasHeight = partHeight;

  console.log(`\n📊 Atlas layout:`);
  console.log(`   Number of parts: ${partCount}`);
  console.log(`   Part size: ${atlasWidth}x${atlasHeight} pixels`);
  console.log(`   Grid: ${framesPerRow} columns × ${maxRowsPerPart} rows`);
  console.log(`   Total frames: ${frameCount}`);
  if (partCount > 1) {
    console.log(`   ⚠️  Multiple parts needed - will create ${partCount} separate files`);
  }
  console.log();

  // Create atlas part(s)
  console.log('🖼️  Compositing frames into atlas...');
  
  let atlasBuffer;
  let actualAtlasWidth = atlasWidth;
  let actualAtlasHeight = atlasHeight;
  
  if (partCount === 1) {
    // Single part with 2D grid
    const rowsInPart = Math.ceil(frameCount / framesPerRow);
    actualAtlasHeight = rowsInPart * frameHeight;
    
    // Always premultiply alpha to prevent halos around transparent edges
    const premultiply = true;
    
    atlasBuffer = await create2DGridAtlas(
      frameFiles,
      frameWidth,
      frameHeight,
      actualAtlasWidth,
      actualAtlasHeight,
      framesPerRow,
      hasAlpha,
      premultiply
    );
  } else {
    // Multiple parts - create each part separately
    console.log(`\n   Creating ${partCount} separate part files...`);
    
    const baseName = path.basename(outputBase);
    const ext = '.ktx2';  // Individual parts are always .ktx2
    const outputDir = path.dirname(outputBase);
    
    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    for (let partIndex = 0; partIndex < partCount; partIndex++) {
      const startFrame = partIndex * framesPerPart;
      const endFrame = Math.min(startFrame + framesPerPart, frameCount);
      const partFrameFiles = frameFiles.slice(startFrame, endFrame);
      const framesInThisPart = endFrame - startFrame;
      
      // Calculate actual dimensions for this part (last part may be smaller)
      const rowsInThisPart = Math.ceil(framesInThisPart / framesPerRow);
      const thisPartWidth = partWidth;
      const thisPartHeight = rowsInThisPart * frameHeight;
      
      console.log(`\n   Part ${partIndex + 1}/${partCount}: frames ${startFrame}-${endFrame - 1}`);
      console.log(`   Grid: ${framesPerRow} cols × ${rowsInThisPart} rows`);
      
      // Always premultiply alpha to prevent halos around transparent edges
      const premultiply = true;
      
      const partBuffer = await create2DGridAtlas(
        partFrameFiles,
        frameWidth,
        frameHeight,
        thisPartWidth,
        thisPartHeight,
        framesPerRow,
        hasAlpha,
        premultiply
      );
      
      // Save and compress this part
      const partOutputPath = path.join(outputDir, `${baseName}_${partIndex}${ext}`);
      await compressPartToKTX2(
        partBuffer,
        thisPartWidth,
        thisPartHeight,
        hasAlpha,
        partOutputPath,
        {
          toktxPath,
          useUASTC,
          useASTC,
          uastcRdo,
          uastcLevel,
          astcQuality,
          astcBlock,
          zstdLevel,
        }
      );
      
      console.log(`   Part ${partIndex + 1} saved: ${partOutputPath}`);
    }
    
    // For multi-part, we don't need the main buffer
    console.log('\n All parts created successfully!');
    
    // Create metadata for multi-part
    const metadata = {
      version: 2,
      format: 'ktx2',
      mode: useASTC ? 'astc' : (uastcRdo > 0 ? 'uastc-rdo' : 'uastc'),
      layout: 'grid-2d',
      frameWidth,
      frameHeight,
      frameCount,
      framesPerPart,
      framesPerRow,
      partCount,
      frameRate,
      uastcRdoLambda: uastcRdo > 0 ? uastcRdo : null,
      hasAlpha,
      hasMipmaps: false,
      createdAt: new Date().toISOString(),
      parts: [] // Will be populated with part info
    };
    
    // Add part info
    for (let i = 0; i < partCount; i++) {
      const startFrame = i * framesPerPart;
      const endFrame = Math.min(startFrame + framesPerPart, frameCount);
      const framesInPart = endFrame - startFrame;
      const rowsInPart = Math.ceil(framesInPart / framesPerRow);
      metadata.parts.push({
        index: i,
        startFrame,
        endFrame: endFrame - 1,
        frameCount: framesInPart,
        rows: rowsInPart,
        columns: framesPerRow,
        file: `${baseName}_${i}${ext}`
      });
    }
    
    const useGLB = options.glb !== false;
    
    if (useGLB) {
      // Package all KTX2 parts into a single GLB container
      console.log('\n📦 Packaging into GLB container...');
      
      const ktx2Files = [];
      for (let i = 0; i < partCount; i++) {
        ktx2Files.push(path.join(outputDir, `${baseName}_${i}${ext}`));
      }
      
      // Change output extension to .glb
      const glbOutputPath = path.join(outputDir, `${baseName}.glb`);
      packageKTX2ToGLB(ktx2Files, metadata, glbOutputPath);
      
      // Clean up individual KTX2 files
      console.log('   Cleaning up temporary KTX2 files...');
      for (const file of ktx2Files) {
        fs.unlinkSync(file);
      }
      
      console.log(`\n✅ GLB container created: ${glbOutputPath}`);
    } else {
      // Keep separate KTX2 files (legacy mode)
      // Inject metadata into first KTX2 file
      console.log('\n📝 Injecting metadata into first KTX2 part...');
      const firstPartPath = path.join(outputDir, `${baseName}_0${ext}`);
      try {
        injectKTX2Metadata(firstPartPath, 'BasisPlayerMetadata', JSON.stringify(metadata));
      } catch (error) {
        console.warn('   ⚠️ Failed to inject metadata into KTX2:', error.message);
      }
      
      // Optionally save separate JSON metadata file
      if (options.jsonMetadata) {
        const metadataPath = path.join(outputDir, `${baseName}.json`);
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        console.log(`   Metadata file: ${metadataPath}`);
      }
      
      console.log(`\n✅ Multi-part KTX2 files created`);
    }
    
    return;
  }

  // Save intermediate PNG for toktx
  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ktx2-'));
  const pngPath = path.join(tempDir, 'atlas.png');
  
  await sharp(atlasBuffer, {
    raw: {
      width: actualAtlasWidth,
      height: actualAtlasHeight,
      channels: hasAlpha ? 4 : 3
    }
  }).png().toFile(pngPath);
  
  console.log(`✓ Atlas PNG created: ${(fs.statSync(pngPath).size / 1024 / 1024).toFixed(2)}MB\n`);

  // Optionally keep the atlas PNG
  if (options.keepAtlas) {
    const outputDir = path.dirname(outputBase);
    const baseName = path.basename(outputBase);
    const atlasOutputPath = path.join(outputDir, `${baseName}_atlas.png`);
    fs.copyFileSync(pngPath, atlasOutputPath);
    console.log(`📁 Atlas PNG saved: ${atlasOutputPath}\n`);
  }

  // Compress to KTX2 (single file case - always .ktx2)
  const outputPath = outputBase + '.ktx2';
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  if (useASTC) {
    // Use toktx for native ASTC encoding
    console.log(`🗜️  Compressing to native ASTC (quality: ${astcQuality}, block: ${astcBlock})...`);
    
    const toktxCommand = [
      toktxPath,
      '--t2',  // Output KTX2 format
      '--encode astc',
      `--astc_blk_d ${astcBlock}`,
      `--astc_quality ${astcQuality}`,
      options.astcPerceptual ? '--astc_perceptual' : null,  // Perceptual optimization
      '--assign_oetf linear',  // Treat input as linear for correct colors
      '--assign_primaries none',  // No color space conversion
      zstdLevel > 0 ? `--zcmp ${zstdLevel}` : null,
      outputPath,
      pngPath
    ].filter(Boolean).join(' ');

    try {
      execSync(toktxCommand, { stdio: 'inherit' });
    } catch (error) {
      console.error('\n❌ ASTC encoding failed!');
      console.error('Make sure toktx (KTX-Software) is installed and in your PATH.');
      console.error('Install: brew install ktx (macOS)');
      console.error('Or download from: https://github.com/KhronosGroup/KTX-Software/releases');
      
      // Cleanup
      fs.rmSync(tempDir, { recursive: true, force: true });
      process.exit(1);
    }
  } else {
    // Use toktx for UASTC encoding
    console.log(`🗜️  Compressing to UASTC...`);
    
    const toktxCommand = [
      toktxPath,
      '--t2',  // Output KTX2 format
      '--encode uastc',
      '--assign_oetf linear',  // Treat input as linear for correct colors
      '--assign_primaries none',  // No color space conversion
      zstdLevel > 0 ? `--zcmp ${zstdLevel}` : null,
      uastcRdo > 0 ? `--uastc_rdo_l ${uastcRdo}` : null,
      outputPath,
      pngPath
    ].filter(Boolean).join(' ');

    try {
      execSync(toktxCommand, { stdio: 'inherit' });
    } catch (error) {
      console.error('\n❌ UASTC encoding failed!');
      console.error('Make sure toktx (KTX-Software) is installed and in your PATH.');
      console.error('Install: brew install ktx (macOS)');
      console.error('Or download from: https://github.com/KhronosGroup/KTX-Software/releases');
      
      // Cleanup
      fs.rmSync(tempDir, { recursive: true, force: true });
      process.exit(1);
    }
  }

  // Create metadata (embedded in KTX2 only, no separate JSON file)
  const metadata = {
    version: 2,
    format: 'ktx2',
    mode: useASTC ? 'astc' : (uastcRdo > 0 ? 'uastc-rdo' : 'uastc'),
    layout: 'grid-2d',
    frameWidth,
    frameHeight,
    frameCount,
    framesPerPart,
    framesPerRow,
    maxRowsPerPart,
    partCount,
    frameRate,
    atlasWidth: actualAtlasWidth,
    atlasHeight: actualAtlasHeight,
    // ASTC-specific metadata
    astcBlockSize: useASTC ? astcBlock : null,
    astcQuality: useASTC ? astcQuality : null,
    zstdLevel: useASTC ? zstdLevel : null,
    // UASTC-specific metadata
    uastcLevel: useUASTC ? uastcLevel : null,
    uastcRdoLambda: uastcRdo > 0 ? uastcRdo : null,
    // General metadata
    hasAlpha,
    hasMipmaps: false,
    createdAt: new Date().toISOString(),
  };

  // Inject metadata into KTX2 file (no separate JSON file needed)
  console.log('\n📝 Injecting metadata into KTX2...');
  injectKTX2Metadata(outputPath, 'BasisPlayerMetadata', JSON.stringify(metadata));

  // Cleanup temp files
  fs.rmSync(tempDir, { recursive: true, force: true });

  // Report results
  const outputSize = fs.statSync(outputPath).size;
  const uncompressedSize = actualAtlasWidth * actualAtlasHeight * (hasAlpha ? 4 : 3);
  const compressionRatio = uncompressedSize / outputSize;

  console.log('\n✅ Encoding complete!\n');
  console.log('📦 Output files:');
  console.log(`   KTX2: ${outputPath} (${(outputSize / 1024 / 1024).toFixed(2)}MB)`);
  console.log(`\n📊 Statistics:`);
  console.log(`   Uncompressed size: ${(uncompressedSize / 1024 / 1024).toFixed(2)}MB`);
  console.log(`   Compressed size: ${(outputSize / 1024 / 1024).toFixed(2)}MB`);
  console.log(`   Compression ratio: ${compressionRatio.toFixed(1)}:1`);
  console.log(`   Space saved: ${((1 - outputSize / uncompressedSize) * 100).toFixed(1)}%`);
  
  if (useASTC) {
    console.log(`\n📋 Format: Native ASTC (highest quality, requires ASTC-capable GPU)`);
  } else {
    console.log(`\n📋 Format: UASTC (universal, transcodes to optimal format per device)`);
  }
  console.log(`🚀 Ready for distribution!`);
}

async function compressPartToKTX2(
  partBuffer,
  partWidth,
  partHeight,
  hasAlpha,
  outputPath,
  encodeOptions
) {
  const {
    toktxPath,
    useUASTC,
    useASTC,
    uastcRdo,
    astcQuality,
    astcBlock,
    zstdLevel,
  } = encodeOptions;

  // Save intermediate PNG
  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'basis-'));
  const pngPath = path.join(tempDir, 'part.png');
  
  await sharp(partBuffer, {
    raw: {
      width: partWidth,
      height: partHeight,
      channels: hasAlpha ? 4 : 3
    }
  }).png().toFile(pngPath);
  
  try {
    if (useASTC) {
      // Use toktx for native ASTC encoding
      const toktxCommand = [
        toktxPath,
        '--t2',  // Output KTX2 format
        '--encode astc',
        `--astc_blk_d ${astcBlock}`,
        `--astc_quality ${astcQuality}`,
        options.astcPerceptual ? '--astc_perceptual' : null,  // Perceptual optimization
        '--assign_oetf linear',  // Treat input as linear for correct colors
        '--assign_primaries none',  // No color space conversion
        zstdLevel > 0 ? `--zcmp ${zstdLevel}` : null,
        outputPath,
        pngPath
      ].filter(Boolean).join(' ');

      execSync(toktxCommand, { stdio: 'inherit' });
    } else {
      // Use toktx for UASTC encoding
      const toktxCommand = [
        toktxPath,
        '--t2',  // Output KTX2 format
        '--encode uastc',
        '--assign_oetf linear',  // Treat input as linear for correct colors
        '--assign_primaries none',  // No color space conversion
        zstdLevel > 0 ? `--zcmp ${zstdLevel}` : null,
        uastcRdo > 0 ? `--uastc_rdo_l ${uastcRdo}` : null,
        outputPath,
        pngPath
      ].filter(Boolean).join(' ');

      execSync(toktxCommand, { stdio: 'inherit' });
    }
  } catch (error) {
    console.error('\n❌ Encoding failed!');
    throw error;
  } finally {
    // Cleanup temp files
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function create2DGridAtlas(
  frameFiles,
  frameWidth,
  frameHeight,
  atlasWidth,
  atlasHeight,
  framesPerRow,
  hasAlpha,
  premultiplyAlpha = true
) {
  const channels = hasAlpha ? 4 : 3;
  
  // Create blank atlas
  const atlasBuffer = Buffer.alloc(atlasWidth * atlasHeight * channels);
  atlasBuffer.fill(0);

  // Process each frame in 2D grid
  for (let i = 0; i < frameFiles.length; i++) {
    const col = i % framesPerRow;
    const row = Math.floor(i / framesPerRow);
    const x = col * frameWidth;
    const y = row * frameHeight;

    process.stdout.write(`\r   Processing frame ${i + 1}/${frameFiles.length}...`);

    try {
      let frameBuffer;
      
      if (hasAlpha) {
        // Read frame with alpha
        const rawBuffer = await sharp(frameFiles[i])
          .resize(frameWidth, frameHeight, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          })
          .ensureAlpha()
          .raw()
          .toBuffer();
        
        if (premultiplyAlpha) {
          // Premultiply alpha to prevent dark halos around transparent edges
          // This ensures transparent pixels don't have dark RGB values that bleed through
          frameBuffer = Buffer.alloc(rawBuffer.length);
          for (let p = 0; p < rawBuffer.length; p += 4) {
            const a = rawBuffer[p + 3] / 255;
            frameBuffer[p] = Math.round(rawBuffer[p] * a);       // R * alpha
            frameBuffer[p + 1] = Math.round(rawBuffer[p + 1] * a); // G * alpha
            frameBuffer[p + 2] = Math.round(rawBuffer[p + 2] * a); // B * alpha
            frameBuffer[p + 3] = rawBuffer[p + 3];                 // A unchanged
          }
        } else {
          // Keep straight alpha for ASTC (toktx expects straight alpha input)
          frameBuffer = rawBuffer;
        }
      } else {
        frameBuffer = await sharp(frameFiles[i])
          .resize(frameWidth, frameHeight, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0 }
          })
          .removeAlpha()
          .raw()
          .toBuffer();
      }

      // Copy frame into 2D grid position
      for (let py = 0; py < frameHeight; py++) {
        const srcRowStart = py * frameWidth * channels;
        const dstRowStart = ((y + py) * atlasWidth + x) * channels;
        
        frameBuffer.copy(
          atlasBuffer,
          dstRowStart,
          srcRowStart,
          srcRowStart + frameWidth * channels
        );
      }
    } catch (error) {
      console.error(`\n\n❌ Failed to process frame ${i + 1}: ${frameFiles[i]}`);
      console.error(error.message);
      throw error;
    }
  }

  console.log(); // New line after progress
  return atlasBuffer;
}

function nextPowerOf2(n) {
  let power = 1;
  while (power < n) {
    power *= 2;
  }
  return power;
}

// Run encoder
encodePNGFramesToBasis().catch(error => {
  console.error('\n❌ Encoding failed:', error.message);
  process.exit(1);
});