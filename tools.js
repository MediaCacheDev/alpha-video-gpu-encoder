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
  toktx: 'KTX-Software: brew install ktx (macOS), or https://github.com/KhronosGroup/KTX-Software/releases',
  astcenc: 'https://github.com/ARM-software/astc-encoder/releases (or brew install astc-encoder); put it on PATH or set $ASTCENC',
  ffmpeg: 'brew install ffmpeg (macOS) or apt install ffmpeg (Linux)',
  zstd: 'brew install zstd (macOS) or apt install zstd (Linux)',
};

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
      version: probeVersion('ffprobe', ['-version']), hint: INSTALL_HINTS.ffmpeg },
    { name: 'zstd', usedFor: '--outer-compression, and compression in the stream encoder',
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

module.exports = { resolveAstcenc, defaultParallelism, runDoctor };
