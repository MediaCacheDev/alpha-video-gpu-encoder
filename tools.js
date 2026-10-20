// Finds the external tools the encoders run, and checks them for `texenc doctor`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// ARM's release zips name the binary after the instruction set it was built for.
const ASTCENC_NAMES = ['astcenc', 'astcenc-native', 'astcenc-neon', 'astcenc-avx2', 'astcenc-sse4.1', 'astcenc-sse2'];

function isExecutableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The astcenc to run: `explicitPath` (from --astcenc) if given, then $ASTCENC, then the first
 * astcenc build on PATH. Returns null when none is found.
 */
function resolveAstcenc(explicitPath) {
  const requested = explicitPath || process.env.ASTCENC;
  if (requested) {
    return requested.includes('/') || requested.includes('\\') ? requested : findOnPath(requested) || requested;
  }
  for (const name of ASTCENC_NAMES) {
    const found = findOnPath(name);
    if (found) return found;
  }
  return null;
}

/** Parallel astcenc processes: the performance cores on Apple silicon, otherwise all cores but one. */
function defaultParallelism() {
  if (process.platform === 'darwin') {
    try {
      const perfCores = parseInt(execSync('/usr/sbin/sysctl -n hw.perflevel0.logicalcpu', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(), 10);
      if (perfCores > 0) return perfCores;
    } catch {
      // Intel Macs have no perflevel keys
    }
  }
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, cores - 1);
}

function firstLine(text) {
  return (text || '').split('\n').map(line => line.trim()).find(Boolean) || '';
}

function probeVersion(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) return null;
  return firstLine(result.stdout) || firstLine(result.stderr) || 'found';
}

const INSTALL_HINTS = {
  toktx: 'Install KTX-Software from https://github.com/KhronosGroup/KTX-Software/releases (.pkg on macOS, .deb, .rpm or .tar.bz2 on Linux), or pass --toktx <path>',
  astcenc: 'Download from https://github.com/ARM-software/astc-encoder/releases, then put it on PATH, set $ASTCENC, or pass --astcenc <path>',
  ffmpeg: 'brew install ffmpeg (macOS) or apt install ffmpeg (Linux); 5.1 or newer',
  ffprobe: 'Comes with ffmpeg: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)',
  zstd: 'brew install zstd (macOS) or apt install zstd (Linux)',
};

function isToolFound(command) {
  return command.includes('/') || command.includes('\\') ? isExecutableFile(command) : findOnPath(command) !== null;
}

/** Exits with an install hint unless `command` (a name on PATH or a path) is found. */
function exitUnlessToolFound(name, usedFor, command = name) {
  if (isToolFound(command)) return;
  console.error(`❌ ${name} not found${command !== name ? `: ${command}` : ' on PATH'}, needed for ${usedFor}`);
  console.error(`   ${INSTALL_HINTS[name]}`);
  console.error('   Run texenc doctor to check every tool');
  process.exit(1);
}

/** Prints which tools are installed and what each is for. Returns false if the default path can't run. */
function runDoctor({ toktx = 'toktx', astcenc } = {}) {
  const astcencPath = resolveAstcenc(astcenc);
  let sharpVersion = null;
  try {
    sharpVersion = `sharp ${require('sharp/package.json').version}`;
  } catch {
    // reported below
  }

  const checks = [
    { name: 'toktx', usedFor: 'every encode except --use-stream-encoder', required: true,
      version: probeVersion(toktx, ['--version']), hint: INSTALL_HINTS.toktx },
    { name: 'astcenc', usedFor: '--use-stream-encoder', path: astcencPath,
      version: astcencPath ? probeVersion(astcencPath, ['-version']) : null, hint: INSTALL_HINTS.astcenc },
    { name: 'ffmpeg', usedFor: '--video input', version: probeVersion('ffmpeg', ['-version']), hint: INSTALL_HINTS.ffmpeg },
    { name: 'ffprobe', usedFor: '--video input, and frame sizes for the stream encoder',
      version: probeVersion('ffprobe', ['-version']), hint: INSTALL_HINTS.ffprobe },
    { name: 'zstd', usedFor: 'compression in the stream encoder',
      version: probeVersion('zstd', ['--version']), hint: INSTALL_HINTS.zstd },
    { name: 'sharp', usedFor: 'reading PNG frames (an npm dependency)', required: true,
      version: sharpVersion, hint: 'reinstall alpha-video-gpu-encoder (npm install)' },
  ];

  console.log(`texenc doctor (node ${process.version}, ${process.platform}-${process.arch})\n`);
  for (const check of checks) {
    const where = check.path && check.version ? ` (${check.path})` : '';
    if (check.version) {
      console.log(`  ✓ ${check.name}: ${check.version}${where}`);
    } else {
      console.log(`  ${check.required ? '✗' : '-'} ${check.name}: not found, needed for ${check.usedFor}`);
      console.log(`      ${check.hint}`);
    }
  }
  console.log(`\n  Parallel astcenc processes by default: ${defaultParallelism()}`);

  return checks.every(check => !check.required || check.version);
}

const LIBVPX_DECODERS = { vp8: 'libvpx', vp9: 'libvpx-vp9' };

/**
 * ffmpeg input options that keep a WebM's alpha: `['-c:v', 'libvpx-vp9']` for VP9 with alpha,
 * `['-c:v', 'libvpx']` for VP8 with alpha, otherwise none. ffmpeg's own VP8 and VP9 decoders
 * ignore the alpha that WebM carries alongside each frame, and would give opaque frames.
 */
function alphaDecoderArgs(videoPath) {
  const result = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name:stream_tags=alpha_mode', '-of', 'json', videoPath,
  ], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  let stream;
  try {
    stream = JSON.parse(result.stdout).streams?.[0];
  } catch {
    return [];
  }
  const decoder = LIBVPX_DECODERS[stream?.codec_name];
  const hasAlpha = Object.entries(stream?.tags || {})
    .some(([key, value]) => key.toLowerCase() === 'alpha_mode' && value === '1');
  return decoder && hasAlpha ? ['-c:v', decoder] : [];
}

module.exports = { resolveAstcenc, defaultParallelism, exitUnlessToolFound, alphaDecoderArgs, INSTALL_HINTS, runDoctor };
