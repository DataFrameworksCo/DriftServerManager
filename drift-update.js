#!/usr/bin/env node
'use strict';

/**
 * Drift Server Manager — offline updater
 * Extracts DriftUpdate.tar (or a path you pass), verifies payload, syncs bin/src/package files, runs npm install.
 * Usage:
 *   node bin/drift-update.js [path/to/DriftUpdate.tar] [--dir /path/to/install] [--dry-run] [--yes]
 *   npm run drift-update
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execFileSync } = require('child_process');

const TAR_BASENAME = 'DriftUpdate.tar';
const PKG_NAME = 'drift';
/** Top-level paths to replace from the archive (node_modules and user data are never touched). */
const SYNC_PATHS = ['bin', 'src', 'package.json', 'package-lock.json'];

function parseArgs(argv) {
  const out = { dryRun: false, yes: false, file: null, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') out.dryRun = true;
    else if (a === '-y' || a === '--yes') out.yes = true;
    else if ((a === '--file' || a === '-f') && argv[i + 1]) out.file = argv[++i];
    else if ((a === '--dir' || a === '-d') && argv[i + 1]) out.dir = argv[++i];
    else if (!a.startsWith('-') && !out.file) out.file = a;
    else if (a.startsWith('-')) {
      console.error('Unknown option:', a);
      process.exit(64);
    }
  }
  return out;
}

function defaultInstallRoot() {
  if (process.env.DRIFT_INSTALL_DIR) {
    return path.resolve(process.env.DRIFT_INSTALL_DIR);
  }
  return path.resolve(__dirname, '..');
}

function readPkgJson(dir) {
  const p = path.join(dir, 'package.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function assertInstallRoot(installRoot) {
  const pkg = readPkgJson(installRoot);
  if (!pkg || pkg.name !== PKG_NAME) {
    throw new Error(
      `Install directory must contain a "${PKG_NAME}" package.json — got ${installRoot}`,
    );
  }
  return pkg;
}

function resolveTarPath(fileArg, installRoot, cwd) {
  if (fileArg) {
    const p = path.resolve(fileArg);
    if (!fs.existsSync(p)) throw new Error(`Update archive not found: ${p}`);
    return p;
  }
  const candidates = [
    path.join(cwd, TAR_BASENAME),
    path.join(installRoot, TAR_BASENAME),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return path.resolve(c);
  }
      throw new Error(
        `No ${TAR_BASENAME} found. Place it in the current directory or install root, or pass the path:\n` +
        `  drift-update /path/to/${TAR_BASENAME}`,
      );
}

function extractTar(tarPath, destDir) {
  try {
    execFileSync('tar', ['--version'], { stdio: 'pipe' });
  } catch {
    throw new Error('The "tar" command is required to extract the update archive.');
  }
  execFileSync('tar', ['-xf', tarPath, '-C', destDir], { stdio: 'inherit' });
}

function findPayloadRoot(tmpDir) {
  const entries = fs
    .readdirSync(tmpDir)
    .filter(e => e !== '.' && e !== '..' && !e.startsWith('PAX'));
  if (entries.length === 1) {
    const one = path.join(tmpDir, entries[0]);
    try {
      if (fs.statSync(one).isDirectory() && fs.existsSync(path.join(one, 'package.json'))) {
        return one;
      }
    } catch {
      /* fall through */
    }
  }
  if (fs.existsSync(path.join(tmpDir, 'package.json'))) return tmpDir;
  throw new Error(
    'Archive must contain package.json at the root or inside a single top-level folder (e.g. DriftServerManager/).',
  );
}

function assertPayload(payloadRoot) {
  const pkg = readPkgJson(payloadRoot);
  if (!pkg || pkg.name !== PKG_NAME) {
    throw new Error(
      `Update package name must be "${PKG_NAME}". Refusing to install this archive.`,
    );
  }
  return pkg;
}

function withinRoot(root, p) {
  const r = path.resolve(root) + path.sep;
  const x = path.resolve(p);
  return x === path.resolve(root) || x.startsWith(r);
}

function safeCopyDir(srcDir, destDir) {
  if (!withinRoot(srcDir, srcDir)) throw new Error('Invalid source path');
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, name.name);
    const d = path.join(destDir, name.name);
    if (!withinRoot(srcDir, s)) continue;
    if (!withinRoot(destDir, d)) throw new Error('Refusing path traversal');
    if (name.isDirectory()) {
      safeCopyDir(s, d);
} else if (name.isFile() || name.isSymbolicLink()) {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
    }
  }
}

function syncPath(installRoot, payloadRoot, name, dryRun) {
  const src = path.join(payloadRoot, name);
  const dest = path.join(installRoot, name);
  if (!fs.existsSync(src)) return;

  if (dryRun) {
    console.log(`  [dry-run] would replace ${name}/`);
    return;
  }

  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true, dereference: true });
  } else {
    fs.copyFileSync(src, dest);
  }
  console.log(`  updated ${name}`);
}

function askYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, ans => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(ans || '').trim()));
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const installRoot = opts.dir ? path.resolve(opts.dir) : defaultInstallRoot();
  const beforePkg = assertInstallRoot(installRoot);
  const tarPath = resolveTarPath(opts.file, installRoot, process.cwd());

  console.log(`Install root: ${installRoot}`);
  console.log(`Current version: ${beforePkg.version || '?'}`);
  console.log(`Archive:         ${tarPath}`);
  if (opts.dryRun) console.log('(dry-run — no files will be changed)\n');

  if (!opts.yes && !opts.dryRun) {
    if (!process.stdin.isTTY) {
      throw new Error('Not a TTY: pass --yes to apply without confirmation.');
    }
    const ok = await askYesNo('Install this update? [y/N] ');
    if (!ok) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-update-'));
  try {
    console.log('\nExtracting archive…');
    extractTar(tarPath, tmpDir);

    const payloadRoot = findPayloadRoot(tmpDir);
    const newPkg = assertPayload(payloadRoot);
    console.log(`Payload version: ${newPkg.version || '?'}`);
    console.log('\nSyncing files…');

    for (const name of SYNC_PATHS) {
      syncPath(installRoot, payloadRoot, name, opts.dryRun);
    }

    if (opts.dryRun) {
      console.log('\n[dry-run] would run: npm install --no-fund --no-audit');
      console.log('Done (dry-run).');
      return;
    }

    console.log('\nInstalling dependencies…');
    execFileSync('npm', ['install', '--no-fund', '--no-audit'], {
      cwd: installRoot,
      stdio: 'inherit',
    });

    const after = readPkgJson(installRoot);
    console.log(`\nUpdate complete — drift ${after?.version || '?'}`);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* empty */
    }
  }
}

(async () => {
  try {
    await main();
  } catch (e) {
    console.error('drift-update:', e.message || e);
    process.exit(1);
  }
})();
