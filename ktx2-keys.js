// KTX2 key/value entries and DFD flags shared by both encoders.
//
// Frame timing goes in KTXanimData, the KTX 2.0 key for array textures whose layers are the
// frames of an animation: per-frame duration and timescale as integers, so 29.97 fps is exactly
// 1001/30000 s per frame. Frame size, frame count and ASTC block size are in the header.

const { execSync } = require('child_process');

// KHR_DF_FLAG_ALPHA_PREMULTIPLIED, in the basic descriptor block's flags byte
const DFD_FLAGS_OFFSET = 15;
const DFD_FLAG_ALPHA_PREMULTIPLIED = 1;

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

function reduced(duration, timescale) {
  const divisor = gcd(duration, timescale);
  return { duration: duration / divisor, timescale: timescale / divisor };
}

/**
 * Parses "30", "29.97" or "30000/1001" into { duration, timescale }, where one frame lasts
 * duration / timescale seconds. Decimal NTSC rates (23.976, 29.97, 59.94) map to their exact
 * 1000/1001 fractions. Returns null for anything else that isn't a positive rate.
 */
function parseFrameRate(text) {
  const fraction = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(text));
  if (fraction) {
    const numerator = parseInt(fraction[1], 10);
    const denominator = parseInt(fraction[2], 10);
    return numerator > 0 && denominator > 0 ? reduced(denominator, numerator) : null;
  }

  const fps = Number(text);
  if (!(fps > 0) || !Number.isFinite(fps)) return null;
  if (Number.isInteger(fps)) return { duration: 1, timescale: fps };
  const ntscBase = Math.round(fps * 1.001);
  if (Math.abs(fps * 1.001 - ntscBase) < 0.001) return reduced(1001, ntscBase * 1000);
  return reduced(1000, Math.round(fps * 1000));
}

function framesPerSecond({ duration, timescale }) {
  return timescale / duration;
}

function formatFrameRate(rate) {
  const fps = framesPerSecond(rate);
  const shown = Number.isInteger(fps) ? String(fps) : fps.toFixed(3).replace(/0+$/, '');
  return rate.duration === 1 ? shown : `${shown} (${rate.timescale}/${rate.duration})`;
}

/** The video's frame rate from ffprobe, or null if it can't be read. */
function probeFrameRate(videoPath) {
  try {
    const output = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate,avg_frame_rate -of csv=p=0 "${videoPath}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    for (const candidate of output.trim().split(',')) {
      const rate = parseFrameRate(candidate);
      if (rate) return rate;
    }
  } catch {
    // reported by the caller
  }
  return null;
}

/** One key/value entry: its byte length, the NUL-terminated key, the value, padding to 4 bytes. */
function kvdEntry(key, value) {
  const keyBytes = Buffer.from(key + '\0', 'utf8');
  const length = keyBytes.length + value.length;
  const entry = Buffer.alloc(4 + length + ((4 - (length % 4)) % 4));
  entry.writeUInt32LE(length, 0);
  keyBytes.copy(entry, 4);
  value.copy(entry, 4 + keyBytes.length);
  return entry;
}

/** KTXanimData's value. loopCount 0 (loop forever); players decide looping with their own prop. */
function animDataValue({ duration, timescale }) {
  const value = Buffer.alloc(12);
  value.writeUInt32LE(duration, 0);
  value.writeUInt32LE(timescale, 4);
  value.writeUInt32LE(0, 8);
  return value;
}

/** Key/value entries must be sorted by the keys' code points. */
function compareKeys(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

module.exports = {
  DFD_FLAGS_OFFSET,
  DFD_FLAG_ALPHA_PREMULTIPLIED,
  parseFrameRate,
  framesPerSecond,
  formatFrameRate,
  probeFrameRate,
  kvdEntry,
  animDataValue,
  compareKeys,
};
