#!/usr/bin/env node

/**
 * Build the optional AI component package (`.whaleai` = 7z).
 *
 * `@anthropic-ai/claude-code` (the ~229MB `claude.exe` binary) +
 * `@anthropic-ai/claude-agent-sdk` are devDependencies — they are NOT shipped
 * in the main installer (see plan.md / builder.json). This script stages them
 * + their peerDeps into `release/ai-component-stage/` with a `manifest.json`,
 * then 7z-compresses into `release/components/whaletag-ai-<version>.whaleai`
 * for users to download and install via Settings → AI → Install from file.
 *
 * Both Anthropic packages have ZERO runtime dependencies, so no recursive
 * dependency collection is needed — only the explicit peerDeps come along so
 * `require('@anthropic-ai/claude-agent-sdk')` resolves at runtime.
 *
 * Mirrors the staging/copy/manifest pattern of scripts/build-extensions.js.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const STAGE = path.join(ROOT, 'release', 'ai-component-stage');
const OUT_DIR = path.join(ROOT, 'release', 'components');

// Packages to bundle. claude-code + claude-agent-sdk are SELF-CONTAINED:
// verified — `require('@anthropic-ai/claude-agent-sdk')` succeeds even with
// NONE of its declared peerDeps (@modelcontextprotocol/sdk / zod /
// @anthropic-ai/sdk) installed, so they are not bundled. Their per-platform
// optionalDeps (the *-win32-x64 / *-darwin-arm64 binaries) ARE copied below.
const PACKAGES = [
  '@anthropic-ai/claude-code',
  '@anthropic-ai/claude-agent-sdk',
];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function readPackage(name) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(path.join(name, 'package.json'));
  } catch {
    return null;
  }
}

function copyPackage(name) {
  const src = path.join(NODE_MODULES, name);
  if (!fs.existsSync(src)) {
    throw new Error(
      `Package not installed: ${name} — run "npm install" first (it is a devDependency).`
    );
  }
  const dest = path.join(STAGE, 'node_modules', name);
  fs.cpSync(src, dest, { recursive: true });
}

function main() {
  console.log('Building WhaleTag AI component package...');

  const claudeCodePkg = readPackage('@anthropic-ai/claude-code');
  const sdkPkg = readPackage('@anthropic-ai/claude-agent-sdk');
  if (!claudeCodePkg || !sdkPkg) {
    throw new Error(
      'Required @anthropic-ai packages not found in node_modules. ' +
        'Run "npm install" (they are devDependencies).'
    );
  }
  const claudeCodeVersion = claudeCodePkg.version;
  const sdkVersion = sdkPkg.version;
  // Component version = claude-code version it ships.
  const componentVersion = claudeCodeVersion;

  cleanDir(STAGE);
  ensureDir(path.join(STAGE, 'node_modules'));

  for (const pkg of PACKAGES) {
    process.stdout.write(`  copy ${pkg} ... `);
    copyPackage(pkg);
    console.log('ok');
  }

  // Include per-platform optionalDeps for BOTH packages (e.g.
  // @anthropic-ai/claude-code-win32-x64, @anthropic-ai/claude-agent-sdk-win32-x64).
  // npm installs only the current platform's, so run this script on each target
  // platform (or in CI matrix) to produce platform-specific .whaleai files.
  const platformDeps = new Set();
  for (const pkg of [claudeCodePkg, sdkPkg]) {
    for (const dep of Object.keys(pkg.optionalDependencies || {})) {
      platformDeps.add(dep);
    }
  }
  for (const dep of platformDeps) {
    const src = path.join(NODE_MODULES, dep);
    if (fs.existsSync(src)) {
      process.stdout.write(`  copy (platform) ${dep} ... `);
      fs.cpSync(src, path.join(STAGE, 'node_modules', dep), { recursive: true });
      console.log('ok');
    }
  }

  const manifest = {
    component: 'ai',
    version: componentVersion,
    claudeCodeVersion,
    sdkVersion,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(STAGE, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
  console.log(
    `  manifest: ai v${componentVersion} ` +
      `(claude-code ${claudeCodeVersion}, sdk ${sdkVersion})`
  );

  ensureDir(OUT_DIR);
  let sevenZip;
  try {
    // eslint-disable-next-line global-require
    sevenZip = require('7zip-bin').path7za;
  } catch {
    throw new Error('7zip-bin not found — run "npm install".');
  }
  const outFile = path.join(
    OUT_DIR,
    `whaletag-ai-${componentVersion}.whaleai`
  );
  fs.rmSync(outFile, { force: true });
  console.log(
    `  compressing → ${path.relative(ROOT, outFile)} (this may take a moment)...`
  );
  execFileSync(
    sevenZip,
    ['a', '-t7z', '-mx=5', '-bd', outFile, 'manifest.json', 'node_modules'],
    { cwd: STAGE, stdio: 'inherit' }
  );

  // Drop the staging dir.
  cleanDir(STAGE);

  const sizeMB = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(1);
  console.log(`Built ${path.relative(ROOT, outFile)} (${sizeMB} MB)`);
}

main();
