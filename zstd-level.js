// zstd-level.js
// Compresses the ASTC layers of a KTX2 level with the zstd CLI, in one of two layouts:
//   - one stream: a single zstd frame, the smallest file; seeking decodes from the start
//   - seek points: an independent zstd frame every few layers, then a seek table in zstd's
//     seekable format (contrib/seekable_format), so a player can start decoding at any frame
// Both are plain zstd to any decoder: frames concatenate, and the table is a skippable frame.

const { spawn } = require('child_process');
const { once } = require('events');

const SEEK_TABLE_MAGIC = 0x184D2A5E;  // skippable frame holding the seek table
const SEEKABLE_FOOTER_MAGIC = 0x8F92EAB1;

function levelArgs(level) {
  return level > 19 ? ['--ultra', `-${level}`] : [`-${level}`];
}

/** Layers per zstd frame for a seek interval in MB of ASTC; 0 means one stream. */
function layersPerSeekPoint(seekIntervalMB, bytesPerLayer) {
  if (!(seekIntervalMB > 0)) return 0;
  return Math.max(1, Math.floor((seekIntervalMB * 1024 * 1024) / bytesPerLayer));
}

/** The seekable format's table: per frame its compressed and decompressed sizes, no checksums. */
function buildSeekTable(frames) {
  const entriesSize = frames.length * 8;
  const table = Buffer.alloc(8 + entriesSize + 9);
  table.writeUInt32LE(SEEK_TABLE_MAGIC, 0);
  table.writeUInt32LE(entriesSize + 9, 4);
  frames.forEach((frame, i) => {
    table.writeUInt32LE(frame.compressedSize, 8 + i * 8);
    table.writeUInt32LE(frame.decompressedSize, 12 + i * 8);
  });
  const footer = 8 + entriesSize;
  table.writeUInt32LE(frames.length, footer);
  table[footer + 4] = 0;  // descriptor: no checksums
  table.writeUInt32LE(SEEKABLE_FOOTER_MAGIC, footer + 5);
  return table;
}

function compressFrame(data, level) {
  return new Promise((resolve, reject) => {
    const zstd = spawn('zstd', [...levelArgs(level), '-c', '-q', `--stream-size=${data.length}`],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let errorText = '';
    zstd.stdout.on('data', (chunk) => chunks.push(chunk));
    zstd.stderr.on('data', (chunk) => { errorText += chunk; });
    zstd.on('error', reject);
    zstd.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`zstd exited with code ${code}: ${errorText.trim()}`));
    });
    zstd.stdin.end(data);
  });
}

/**
 * Takes layers in order and hands the compressed level data to `write`, in order. With seek
 * points, up to `parallel` frames compress at once, each in its own zstd process.
 */
class LevelCompressor {
  constructor({ level, layersPerSeekPoint, parallel = 1, write }) {
    this.level = level;
    this.layersPerFrame = layersPerSeekPoint;
    this.parallel = Math.max(1, parallel);
    this.write = write;
    this.compressedBytes = 0;
    this.frames = [];
    this.pendingLayers = [];
    this.inFlight = [];
    if (!this.layersPerFrame) this.startStream();
  }

  get seekPoints() {
    return this.frames.length > 1 ? this.frames.length : 0;
  }

  startStream() {
    this.stream = spawn('zstd', [...levelArgs(this.level), '-c'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.stream.stdout.on('data', (chunk) => this.emit(chunk));
    this.stream.stderr.on('data', () => {});  // progress output
    this.streamClosed = once(this.stream, 'close');
    this.streamClosed.catch(() => {});  // a failed spawn surfaces in finish()
  }

  emit(chunk) {
    this.write(chunk);
    this.compressedBytes += chunk.length;
  }

  async addLayer(layer) {
    if (this.stream) {
      if (!this.stream.stdin.write(layer)) await once(this.stream.stdin, 'drain');
      return;
    }
    this.pendingLayers.push(layer);
    if (this.pendingLayers.length === this.layersPerFrame) await this.compressPendingLayers();
  }

  async compressPendingLayers() {
    const data = Buffer.concat(this.pendingLayers);
    this.pendingLayers = [];
    this.inFlight.push({ result: compressFrame(data, this.level), decompressedSize: data.length });
    if (this.inFlight.length >= this.parallel) await this.writeOldestFrame();
  }

  async writeOldestFrame() {
    const { result, decompressedSize } = this.inFlight.shift();
    const compressed = await result;
    this.emit(compressed);
    this.frames.push({ compressedSize: compressed.length, decompressedSize });
  }

  /** Writes what is left, and the seek table when there is more than one frame. */
  async finish() {
    if (this.stream) {
      this.stream.stdin.end();
      const [code] = await this.streamClosed;
      if (code !== 0) throw new Error(`zstd exited with code ${code}`);
      return this.compressedBytes;
    }
    if (this.pendingLayers.length > 0) await this.compressPendingLayers();
    while (this.inFlight.length > 0) await this.writeOldestFrame();
    if (this.frames.length > 1) this.emit(buildSeekTable(this.frames));
    return this.compressedBytes;
  }
}

/** Compresses a whole level held in memory. */
async function compressLevelData(data, { level, bytesPerLayer, layersPerSeekPoint, parallel }) {
  const chunks = [];
  const compressor = new LevelCompressor({ level, layersPerSeekPoint, parallel, write: (c) => chunks.push(c) });
  for (let offset = 0; offset < data.length; offset += bytesPerLayer) {
    await compressor.addLayer(data.subarray(offset, offset + bytesPerLayer));
  }
  await compressor.finish();
  return { data: Buffer.concat(chunks), seekPoints: compressor.seekPoints };
}

module.exports = { LevelCompressor, compressLevelData, layersPerSeekPoint, buildSeekTable };
