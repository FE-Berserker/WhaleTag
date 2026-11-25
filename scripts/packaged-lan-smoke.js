#!/usr/bin/env node

/**
 * Real desktop + mobile LAN sharing smoke against the packaged application.
 *
 * Default:
 *   node scripts/packaged-lan-smoke.js [path/to/WhaleTag.exe]
 *
 * Current production build without repackaging:
 *   WHALETAG_GUI_USE_CURRENT_BUILD=1 node scripts/packaged-lan-smoke.js
 *
 * Optional overrides: WHALETAG_GUI_EXECUTABLE, WHALETAG_GUI_MAIN and
 * WHALETAG_GUI_ARTIFACTS_DIR. Every run uses an isolated Windows profile and a
 * unique artifacts/packaged-lan-smoke-* directory. Pairing secrets are never
 * printed or persisted in the report; the clipboard is restored after the run.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { _electron: electron, expect } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'release', 'app', 'dist', 'main', 'main.js');
const DEFAULT_EXECUTABLE = path.join(
  ROOT,
  'release',
  'build',
  'win-unpacked',
  'WhaleTag.exe'
);
const useCurrentBuild = process.env.WHALETAG_GUI_USE_CURRENT_BUILD === '1';
const executablePath = path.resolve(
  process.env.WHALETAG_GUI_EXECUTABLE ||
    (useCurrentBuild ? require('electron') : process.argv[2] || DEFAULT_EXECUTABLE)
);
const entryPoint = process.env.WHALETAG_GUI_MAIN
  ? path.resolve(process.env.WHALETAG_GUI_MAIN)
  : useCurrentBuild
    ? MAIN
    : null;
const artifactsParent = path.resolve(
  process.env.WHALETAG_GUI_ARTIFACTS_DIR || path.join(ROOT, 'artifacts')
);
const LOCATION_NAME = 'LAN smoke fixture';
const LAN_ROOT_NAME = 'fixture';
const NOTE_NAME = 'lan-note.txt';
const NOTE_CONTENT = 'WhaleTag LAN smoke\nRead-only text preview.\n';
const IMAGE_NAME = 'lan-pixel.png';
const SECOND_IMAGE_NAME = 'lan-landscape.png';
const DOCUMENT_NAME = 'project-notes.md';
const DOWNLOAD_NAME = 'reference.pdf';
const SECOND_FOLDER_NAME = 'references';
const NESTED_NAME = 'nested';
const DEEP_FOLDER_NAME = 'deeper';
const ROOT_ENTRY_COUNT = 7;
const TAG = 'lan-smoke-tag';
const secrets = new Set();

function errorText(error) {
  return String((error && error.stack) || error);
}

function redact(value) {
  let text = String(value);
  const ordered = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const secret of ordered) text = text.split(secret).join('<redacted>');
  return text;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
        milliseconds
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function poll(read, milliseconds, label) {
  const deadline = Date.now() + milliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `${label} timed out after ${milliseconds}ms${lastError ? `: ${errorText(lastError)}` : ''}`
  );
}

function urlPath(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return '<invalid-url>';
  }
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

/** A deterministic, real-size raster fixture makes thumbnail/grid review meaningful. */
function createPng(width, height, paint) {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    scanlines[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = paint(x, y, width, height);
      const offset = row + 1 + x * 4;
      scanlines[offset] = r;
      scanlines[offset + 1] = g;
      scanlines[offset + 2] = b;
      scanlines[offset + 3] = a;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** atime is deliberately excluded: reading a file may legitimately update it. */
function snapshotWhale(fixtureRoot) {
  const base = path.join(fixtureRoot, '.whale');
  const files = [];
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    const children = fs.readdirSync(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) {
        walk(absolute);
        continue;
      }
      assert.ok(child.isFile(), `Unexpected non-file entry below .whale: ${absolute}`);
      const stat = fs.statSync(absolute);
      const relativePath = path.relative(base, absolute).split(path.sep).join('/');
      if (relativePath === 'index.db-shm') {
        // Read-only SQLite connections update WAL read-mark/lock bytes in the
        // shared-memory index. Keep creation/deletion and size strict without
        // mistaking those transient bytes for a database content write.
        files.push({ path: relativePath, size: stat.size });
      } else {
        files.push({
          path: relativePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          sha256: hashFile(absolute),
        });
      }
    }
  }
  walk(base);
  return { files };
}

function snapshotDiff(before, after) {
  const previous = new Map(before.files.map((file) => [file.path, file]));
  const current = new Map(after.files.map((file) => [file.path, file]));
  const diff = { created: [], deleted: [], changed: [] };
  for (const [name, file] of current) {
    if (!previous.has(name)) diff.created.push(name);
    else if (JSON.stringify(previous.get(name)) !== JSON.stringify(file)) {
      diff.changed.push({ path: name, before: previous.get(name), after: file });
    }
  }
  for (const name of previous.keys()) {
    if (!current.has(name)) diff.deleted.push(name);
  }
  return diff;
}

async function stableWhaleSnapshot(fixtureRoot) {
  let previous = snapshotWhale(fixtureRoot);
  let stableReads = 1;
  const deadline = Date.now() + 30_000;
  while (stableReads < 3 && Date.now() < deadline) {
    await delay(500);
    const current = snapshotWhale(fixtureRoot);
    if (JSON.stringify(current) === JSON.stringify(previous)) stableReads += 1;
    else stableReads = 1;
    previous = current;
  }
  assert.equal(stableReads, 3, '.whale did not become stable after indexing');
  assert.ok(
    previous.files.some((file) => file.path === 'index.db'),
    'Indexing must create .whale/index.db before LAN sharing starts'
  );
  assert.ok(
    previous.files.some((file) => file.path === 'wsd.json'),
    'The fixture tag must be persisted in .whale/wsd.json before indexing'
  );
  return previous;
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('Packaged LAN smoke currently supports Windows artifacts only');
  }
  if (!fs.existsSync(executablePath)) {
    throw new Error(
      `LAN smoke executable not found: ${executablePath}\n` +
        'Build it with: npm run package:win -- --dir\n' +
        'Or set WHALETAG_GUI_USE_CURRENT_BUILD=1 after: npm run build'
    );
  }
  if (entryPoint && !fs.existsSync(entryPoint)) {
    throw new Error(`GUI main entry point not found: ${entryPoint}\nBuild it with: npm run build`);
  }
  if (
    useCurrentBuild &&
    !fs.existsSync(path.join(ROOT, 'release', 'app', 'dist', 'mobile', 'index.html'))
  ) {
    throw new Error('Current mobile bundle not found: release/app/dist/mobile/index.html');
  }

  fs.mkdirSync(artifactsParent, { recursive: true });
  const outputDirectory = fs.mkdtempSync(path.join(artifactsParent, 'packaged-lan-smoke-'));
  const runtimeRoot = path.join(outputDirectory, 'runtime');
  const fixtureRoot = path.join(outputDirectory, 'fixture');
  const downloadsDirectory = path.join(outputDirectory, 'downloads');
  const env = {
    ...process.env,
    APPDATA: path.join(runtimeRoot, 'appdata'),
    LOCALAPPDATA: path.join(runtimeRoot, 'local-appdata'),
    TEMP: path.join(runtimeRoot, 'tmp'),
    TMP: path.join(runtimeRoot, 'tmp'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const directory of [
    fixtureRoot,
    path.join(fixtureRoot, NESTED_NAME),
    path.join(fixtureRoot, NESTED_NAME, DEEP_FOLDER_NAME),
    path.join(fixtureRoot, SECOND_FOLDER_NAME),
    env.APPDATA,
    env.LOCALAPPDATA,
    env.TEMP,
    downloadsDirectory,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(fixtureRoot, NOTE_NAME), NOTE_CONTENT, 'utf8');
  fs.writeFileSync(path.join(fixtureRoot, NESTED_NAME, 'inside.txt'), 'Nested LAN file\n');
  fs.writeFileSync(
    path.join(fixtureRoot, NESTED_NAME, DEEP_FOLDER_NAME, 'deep.txt'),
    'Deep nested LAN file\n'
  );
  fs.writeFileSync(
    path.join(fixtureRoot, DOCUMENT_NAME),
    '# Project notes\n\nA realistic document row for mobile layout review.\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(fixtureRoot, DOWNLOAD_NAME),
    '%PDF-1.4\n% Read-only LAN download fixture\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(fixtureRoot, SECOND_FOLDER_NAME, 'reference.txt'),
    'Reference material\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(fixtureRoot, IMAGE_NAME),
    createPng(320, 220, (x, y, width, height) => {
      const sun = (x - 245) ** 2 + (y - 62) ** 2 < 42 ** 2;
      if (sun) return [255, 209, 102];
      if (y > height * 0.7) return [20, 91, 85];
      if (y > height * 0.52 + Math.sin(x / 42) * 20) return [38, 129, 115];
      return [26 + Math.floor((x / width) * 28), 111, 173 + Math.floor((y / height) * 45)];
    })
  );
  fs.writeFileSync(
    path.join(fixtureRoot, SECOND_IMAGE_NAME),
    createPng(480, 320, (x, y, width, height) => {
      const stripe = (Math.floor(x / 48) + Math.floor(y / 40)) % 2 === 0;
      const orb = (x - width * 0.32) ** 2 + (y - height * 0.44) ** 2 < 72 ** 2;
      if (orb) return [244, 114, 182];
      return stripe ? [49, 46, 129] : [67, 56, 202];
    })
  );

  const report = {
    name: 'packaged-lan-smoke',
    startedAt: new Date().toISOString(),
    launch: { executablePath, entryPoint, currentBuildOverride: useCurrentBuild },
    outputDirectory,
    ok: false,
    currentStep: 'setup',
    steps: [],
    screenshots: [],
    console: [],
    expectedConsole: [],
    pageErrors: [],
    requestFailed: [],
    abortedRequests: [],
    httpErrors: [],
    expectedDisconnects: [],
    cleanupErrors: [],
    limitations: [
      'The native OS directory picker is bridged to the isolated fixture; native dialog chrome is not automated.',
      'A second sandboxed BrowserWindow in a minimal Electron harness represents the mobile browser, not a physical phone.',
      'Horizontal geometry is asserted, not pixel-by-pixel visual diffs.',
      'The isolated runtime profile and fixture are removed after verification; redacted reports and screenshots remain.',
    ],
  };
  const reportPath = path.join(outputDirectory, 'result.json');
  const saveReport = () => {
    fs.writeFileSync(reportPath, redact(JSON.stringify(report, null, 2)) + '\n', 'utf8');
  };
  saveReport();

  let app;
  let mobileApp;
  let desktop;
  let mobile;
  let originalClipboard = null;
  let clipboardTouched = false;
  let allowStoppedListDisconnect = false;
  let screenshotSequence = 0;
  let beforeLan = null;
  let pairingUrl = null;
  let pairingToken = null;
  let baseUrl = null;

  // After Stop, one Refresh makes the mobile client's list and tags requests
  // fail together. Each surfaces as one refused request, one Chromium resource
  // error and one client warning: all of them are the expected offline report.
  const STOPPED_REFRESH_PATHS = new Set(['/api/list', '/api/tags']);
  const STOP_FAILURE_REASON = 'The refresh after Stop must fail at the closed LAN transport.';
  const STOP_WARNING_REASON = 'The mobile client reports the refused request that Stop must cause.';
  const countExpected = (reason) => report.expectedConsole.filter((entry) => entry.reason === reason).length;
  /** Resolve once no console / request diagnostics arrived for 600 ms (max 5 s). */
  async function settleDiagnostics() {
    const signature = () =>
      report.console.length +
      report.expectedConsole.length +
      report.requestFailed.length +
      report.expectedDisconnects.length +
      report.abortedRequests.length;
    let stable = 0;
    const startedAt = Date.now();
    while (stable < 3 && Date.now() - startedAt < 5_000) {
      const before = signature();
      await delay(200);
      stable = signature() === before ? stable + 1 : 0;
    }
  }

  function attachDiagnostics(page, owner) {
    page.on('console', (message) => {
      if (message.type() !== 'warning' && message.type() !== 'error') return;
      const item = { owner, type: message.type(), text: redact(message.text()) };
      const warningSource = (text) => text.split(' TypeError')[0];
      const expectedReason = owner === 'mobile' &&
        message.type() === 'warning' &&
        item.text.includes('Electron Security Warning (Insecure Resources)')
        ? 'The minimal Electron harness intentionally loads the real LAN client over HTTP.'
        : owner === 'mobile' &&
            message.type() === 'error' &&
            item.text === "The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element."
          ? 'frame-ancestors is enforced by the HTTP response header; Chromium only ignores its duplicate meta directive.'
          : owner === 'mobile' &&
              allowStoppedListDisconnect &&
              message.type() === 'error' &&
              /^Failed to load resource: net::ERR_(?:CONNECTION_REFUSED|EMPTY_RESPONSE)$/.test(item.text) &&
              countExpected(STOP_FAILURE_REASON) < STOPPED_REFRESH_PATHS.size
            ? STOP_FAILURE_REASON
            : owner === 'mobile' &&
                allowStoppedListDisconnect &&
                message.type() === 'warning' &&
                /^\[mobile\] (?:content|tags) request failed\b/.test(item.text) &&
                !report.expectedConsole.some(
                  (entry) =>
                    entry.reason === STOP_WARNING_REASON &&
                    warningSource(entry.text) === warningSource(item.text)
                )
              ? STOP_WARNING_REASON
              : null;
      if (expectedReason) report.expectedConsole.push({ ...item, reason: expectedReason });
      else report.console.push(item);
      saveReport();
    });
    page.on('pageerror', (error) => {
      report.pageErrors.push({ owner, message: redact(errorText(error)) });
      saveReport();
    });
    page.on('requestfailed', (request) => {
      const item = {
        owner,
        method: request.method(),
        path: urlPath(request.url()),
        resourceType: request.resourceType(),
        errorText: redact(request.failure()?.errorText || 'unknown request failure'),
      };
      const expectedOffline =
        allowStoppedListDisconnect &&
        owner === 'mobile' &&
        item.method === 'GET' &&
        STOPPED_REFRESH_PATHS.has(item.path) &&
        ['net::ERR_CONNECTION_REFUSED', 'net::ERR_EMPTY_RESPONSE'].includes(item.errorText) &&
        !report.expectedDisconnects.some((entry) => entry.path === item.path);
      if (expectedOffline) {
        report.expectedDisconnects.push({
          ...item,
          reason: 'LAN Stop closed the listener; the mobile client must report offline content.',
        });
      } else if (item.errorText.includes('ERR_ABORTED')) report.abortedRequests.push(item);
      else report.requestFailed.push(item);
      saveReport();
    });
    page.on('response', (response) => {
      if (response.status() < 400) return;
      report.httpErrors.push({
        owner,
        method: response.request().method(),
        path: urlPath(response.url()),
        status: response.status(),
      });
      saveReport();
    });
  }

  async function step(name, action) {
    report.currentStep = name;
    const startedAt = Date.now();
    try {
      const result = await action();
      report.steps.push({ name, ok: true, durationMs: Date.now() - startedAt, result });
      saveReport();
      console.log(`PASS ${name}`);
      return result;
    } catch (error) {
      report.steps.push({
        name,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: redact(errorText(error)),
      });
      saveReport();
      throw error;
    }
  }

  async function capture(page, name, options = {}) {
    screenshotSequence += 1;
    const file = `${String(screenshotSequence).padStart(2, '0')}-${name}.png`;
    const absolute = path.join(outputDirectory, file);
    const qr = options.maskQr
      ? page.locator('img[alt="QR code for LAN pairing"]')
      : null;
    const qrCount = qr ? await qr.count() : 0;
    if (options.maskQr) {
      assert.equal(qrCount, 1, 'Exactly one QR image must be present for masked capture');
    }
    await page.screenshot({
      path: absolute,
      fullPage: false,
      animations: 'disabled',
      mask: qr ? [qr] : undefined,
      maskColor: '#000000',
    });
    const geometry = await page.evaluate(() => ({
      viewport: { width: innerWidth, height: innerHeight },
      body: { width: document.body.scrollWidth, height: document.body.scrollHeight },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
    }));
    report.screenshots.push({
      file,
      ...geometry,
      qrMasked: qrCount > 0,
      qrPresent: qr ? qrCount > 0 : undefined,
    });
    saveReport();
  }

  async function openSettings() {
    const button = desktop.getByTestId('settings-button');
    await expect(button).toHaveCount(1);
    await button.click();
    const dialog = desktop.getByTestId('settings-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(dialog).toHaveCount(1);
    return dialog;
  }

  async function closeSettings(dialog) {
    await desktop.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
  }

  async function assertNoHorizontalOverflow(page, label) {
    const geometry = await page.evaluate(() => ({
      viewport: { width: innerWidth, height: innerHeight },
      bodyWidth: document.body.scrollWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    assert.ok(
      geometry.bodyWidth <= geometry.viewport.width &&
        geometry.documentWidth <= geometry.viewport.width,
      `${label} has horizontal overflow: ${JSON.stringify(geometry)}`
    );
    const paper = page.locator('.MuiDialog-paper');
    if ((await paper.count()) > 0) {
      const dialogGeometry = await paper.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        };
      });
      assert.ok(
        dialogGeometry.left >= 0 &&
          dialogGeometry.right <= geometry.viewport.width &&
          dialogGeometry.scrollWidth <= dialogGeometry.clientWidth,
        `${label} Dialog Paper escapes its viewport: ${JSON.stringify(dialogGeometry)}`
      );
      geometry.dialog = dialogGeometry;
    }
    return geometry;
  }

  try {
    await step('cold-start-add-location', async () => {
      app = await electron.launch({
        executablePath,
        args: entryPoint ? [entryPoint] : [],
        env,
        timeout: 30_000,
      });
      desktop = await withTimeout(app.firstWindow(), 20_000, 'first desktop window');
      attachDiagnostics(desktop, 'desktop');
      await desktop.waitForLoadState('domcontentloaded');
      const expectedRenderer = useCurrentBuild ? 'release/app/dist/renderer/index.html' : 'app.asar';
      assert.ok(desktop.url().includes(expectedRenderer), 'Unexpected desktop renderer URL');
      await desktop
        .getByRole('heading', { name: 'Welcome to WhaleTag', exact: true })
        .waitFor({ state: 'visible', timeout: 20_000 });

      originalClipboard = await app.evaluate(({ clipboard }) => ({
        text: clipboard.readText(),
        formats: clipboard.availableFormats().map((format) => {
          const value = format === 'text/html' ? clipboard.readHTML() : clipboard.readText();
          return { format, data: Buffer.from(value, 'utf8').toString('base64') };
        }),
      }));
      const formats = originalClipboard.formats.map((item) => item.format);
      const canRestore =
        (formats.length === 0 && !originalClipboard.text) ||
        formats.every((format) => format === 'text/plain' || format === 'text/html');
      assert.ok(
        canRestore,
        `LAN smoke can only restore empty/plain-text/HTML clipboard data; found: ${formats.join(', ')}`
      );
      const sentinel = `whale-lan-smoke-before-${Date.now()}`;
      await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), sentinel);
      clipboardTouched = true;

      await app.evaluate(({ dialog }, root) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
      }, fixtureRoot);
      const welcome = desktop
        .getByRole('heading', { name: 'Welcome to WhaleTag', exact: true })
        .locator('..');
      await welcome.getByRole('button', { name: 'Add Location', exact: true }).click();
      const dialog = desktop.getByRole('dialog', { name: 'Add Location', exact: true });
      await dialog.getByRole('textbox', { name: 'Location name', exact: true }).fill(LOCATION_NAME);
      await dialog.getByRole('button', { name: 'Browse', exact: true }).click();
      const folder = dialog.getByRole('textbox', { name: 'Folder path', exact: true });
      await poll(async () => (await folder.inputValue()) || null, 5_000, 'fixture path bridge');
      assert.equal(await folder.inputValue(), fs.realpathSync(fixtureRoot));
      await dialog.getByRole('button', { name: 'Add', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      for (const name of [
        NOTE_NAME,
        IMAGE_NAME,
        SECOND_IMAGE_NAME,
        DOCUMENT_NAME,
        DOWNLOAD_NAME,
        NESTED_NAME,
        SECOND_FOLDER_NAME,
      ]) {
        await expect(desktop.getByTitle(name, { exact: true })).toHaveCount(1, { timeout: 30_000 });
      }
      await capture(desktop, 'desktop-fixture');
      return { location: LOCATION_NAME, fixtureEntries: ROOT_ENTRY_COUNT };
    });

    await step('tag-index-and-metadata-snapshot', async () => {
      const row = desktop.getByTitle(NOTE_NAME, { exact: true });
      await row.click({ button: 'right' });
      const editor = desktop.getByTestId('entry-edit-tags');
      await editor.waitFor({ state: 'visible' });
      const tagInput = editor.getByRole('textbox', { name: 'Add tag, press Enter', exact: true });
      await tagInput.fill(TAG);
      await tagInput.press('Enter');
      await expect(editor.getByText(TAG, { exact: true })).toBeVisible();
      await desktop.keyboard.press('Escape');
      await expect(editor).toHaveCount(0);
      await poll(
        async () => fs.existsSync(path.join(fixtureRoot, '.whale', 'wsd.json')) || null,
        10_000,
        'tag sidecar write'
      );

      const advanced = desktop.getByRole('button', { name: 'Advanced search', exact: true });
      if ((await advanced.count()) === 0) {
        const action = await poll(async () => {
          if ((await advanced.count()) === 1) return 'ready';
          for (const name of ['Build Index', 'Rebuild Index']) {
            const button = desktop.getByRole('button', { name, exact: true });
            if ((await button.count()) === 1) return button;
          }
          return null;
        }, 30_000, 'index build action');
        if (action !== 'ready') {
          await action.click();
          await poll(
            async () => ((await advanced.count()) === 1 ? advanced : null),
            60_000,
            'desktop index ready'
          );
        }
      }
      await expect(advanced).toHaveCount(1);
      beforeLan = await stableWhaleSnapshot(fixtureRoot);
      report.whaleBeforeLan = beforeLan;
      saveReport();
      return { tag: TAG, indexed: true, whaleFileCount: beforeLan.files.length };
    });

    await step('desktop-lan-start-and-clipboard-pairing', async () => {
      const dialog = await openSettings();
      await desktop.getByTestId('settings-nav-lan').click();
      await dialog.getByRole('button', { name: 'Start LAN sharing', exact: true }).click();
      await dialog.getByRole('button', { name: 'Stop LAN sharing', exact: true }).waitFor({
        state: 'visible',
        timeout: 20_000,
      });
      await expect(dialog.getByRole('status').filter({ hasText: 'Running' })).toHaveCount(1);
      const copy = dialog.getByRole('button', { name: 'Copy pairing link', exact: true });
      await expect(copy).toHaveCount(1, { timeout: 20_000 });
      const qr = dialog.getByRole('img', { name: 'QR code for LAN pairing', exact: true });
      await expect(qr).toBeVisible({ timeout: 20_000 });

      const sentinel = await app.evaluate(({ clipboard }) => clipboard.readText());
      await copy.click();
      pairingUrl = await poll(async () => {
        const value = await app.evaluate(({ clipboard }) => clipboard.readText());
        return value !== sentinel && /^http:\/\//.test(value) ? value : null;
      }, 10_000, 'pairing URL clipboard write');
      secrets.add(pairingUrl);
      const parsed = new URL(pairingUrl);
      pairingToken = new URLSearchParams(parsed.hash.replace(/^#/, '')).get('token');
      assert.ok(pairingToken, 'Clipboard pairing URL must contain a fragment token');
      secrets.add(pairingToken);
      secrets.add(encodeURIComponent(pairingToken));
      assert.equal(parsed.protocol, 'http:');
      assert.equal(parsed.username, '');
      assert.equal(parsed.password, '');
      baseUrl = `${parsed.origin}/`;
      await expect(dialog.getByRole('status').filter({ hasText: 'Pairing link copied' })).toHaveCount(1);

      const selector = dialog.getByRole('combobox', { name: 'Base URL', exact: true });
      const selectorCount = await selector.count();
      assert.ok(selectorCount <= 1, 'Expected at most one LAN Base URL selector');
      if (selectorCount === 1) assert.ok((await selector.innerText()).includes(baseUrl));
      else {
        // One adapter: a plain settings row whose label and URL are separate
        // text nodes (the row primitives render label + hint), so read the row.
        const row = dialog.getByText('Base URL', { exact: true });
        await expect(row).toHaveCount(1);
        await expect(row.locator('..').locator('..')).toContainText(baseUrl);
      }
      const desktopText = await desktop.locator('body').innerText();
      assert.ok(!desktopText.includes(pairingToken), 'Pairing token must never be page text');
      assert.ok(!desktopText.includes(pairingUrl), 'Full pairing URL must never be page text');
      await capture(desktop, 'desktop-lan-running-qr-masked', { maskQr: true });
      const afterStart = snapshotWhale(fixtureRoot);
      const diff = snapshotDiff(beforeLan, afterStart);
      assert.deepEqual(diff, { created: [], deleted: [], changed: [] });
      await closeSettings(dialog);
      return {
        running: true,
        baseUrl,
        urlMode: selectorCount === 1 ? 'selector' : 'readable-text',
        qrVisibleAndMaskedInScreenshot: true,
        clipboardTransferVerified: true,
      };
    });

    await step('mobile-pair-session-and-sandbox', async () => {
      const mobileHarnessPath = path.join(outputDirectory, 'mobile-window.cjs');
      fs.writeFileSync(mobileHarnessPath, `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const downloadDirectory = process.env.WHALETAG_LAN_DOWNLOAD_DIRECTORY;
const downloadStatePath = path.join(downloadDirectory, 'download-state.json');
function recordDownload(value) {
  const temporary = downloadStatePath + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value), 'utf8');
  fs.renameSync(temporary, downloadStatePath);
}
app.commandLine.appendSwitch('lang', 'en-US');
app.on('window-all-closed', () => app.quit());
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 390,
    height: 844,
    useContentSize: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
      webSecurity: true,
      spellcheck: false
    }
  });
  window.webContents.session.on('will-download', (_event, item) => {
    const filename = path.basename(item.getFilename());
    const savePath = path.join(downloadDirectory, filename);
    const download = {
      filename,
      savePath,
      url: item.getURL(),
      disposition: item.getContentDisposition(),
      mimeType: item.getMimeType()
    };
    item.setSavePath(savePath);
    recordDownload({ ...download, state: 'started' });
    item.once('done', (_doneEvent, state) => {
      recordDownload({
        ...download,
        state,
        totalBytes: item.getTotalBytes(),
        receivedBytes: item.getReceivedBytes()
      });
    });
  });
  window.loadURL('about:blank');
});
`, 'utf8');
      mobileApp = await electron.launch({
        executablePath: path.resolve(require('electron')),
        args: [mobileHarnessPath],
        env: { ...env, WHALETAG_LAN_DOWNLOAD_DIRECTORY: downloadsDirectory },
        timeout: 30_000,
      });
      mobile = await withTimeout(mobileApp.firstWindow(), 20_000, 'mobile harness window');
      attachDiagnostics(mobile, 'mobile');
      const sessionResponsePromise = mobile.waitForResponse(
        (response) => urlPath(response.url()) === '/api/session' && response.request().method() === 'POST',
        { timeout: 20_000 }
      );
      await mobile.goto(pairingUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      const sessionResponse = await sessionResponsePromise;
      assert.equal(sessionResponse.status(), 204);
      const rootSelector = mobile.getByRole('combobox', { name: 'Select a location', exact: true });
      await rootSelector.waitFor({ state: 'visible', timeout: 20_000 });
      assert.ok((await rootSelector.innerText()).includes(LAN_ROOT_NAME));
      await poll(
        async () => (await mobile.evaluate(() => window.location.hash)) === '' || null,
        5_000,
        'fragment token removal'
      );
      const isolation = await mobile.evaluate(() => ({
        whale: typeof window.whale,
        require: typeof window.require,
        process: typeof window.process,
      }));
      assert.deepEqual(isolation, { whale: 'undefined', require: 'undefined', process: 'undefined' });
      const cookies = await mobile.context().cookies(baseUrl);
      const session = cookies.find((cookie) => cookie.name === 'whale_lan_session');
      assert.ok(session, 'Pairing must create a session cookie');
      assert.equal(session.httpOnly, true);
      assert.equal(session.sameSite, 'Strict');
      assert.ok(!(await mobile.evaluate(() => document.cookie)).includes('whale_lan_session'));
      await expect(mobile.getByText('Read-only access', { exact: true })).toHaveCount(1);
      await expect(mobile.getByLabel('Pairing token', { exact: true })).toHaveCount(0);
      const mobileText = await mobile.locator('body').innerText();
      assert.ok(!mobileText.includes(pairingToken), 'Mobile page text must not contain the token');
      const geometry = await assertNoHorizontalOverflow(mobile, 'mobile 390x844 root');
      assert.equal(geometry.viewport.width, 390);
      assert.ok(
        geometry.viewport.height >= 844 && geometry.viewport.height <= 846,
        `Unexpected 390px mobile viewport height: ${geometry.viewport.height}`
      );
      await capture(mobile, 'mobile-390-root');
      return {
        requestedWindow: { width: 390, height: 844 },
        sessionStatus: sessionResponse.status(),
        cookie: { httpOnly: true, sameSite: 'Strict', domVisible: false },
        fragmentRemoved: true,
        isolation,
      };
    });

    await step('mobile-directories-breadcrumbs-and-search', async () => {
      const entryButtons = mobile.locator('.entry-grid .entry-button');
      await expect(entryButtons).toHaveCount(ROOT_ENTRY_COUNT);
      for (const name of [
        NOTE_NAME,
        IMAGE_NAME,
        SECOND_IMAGE_NAME,
        DOCUMENT_NAME,
        DOWNLOAD_NAME,
        NESTED_NAME,
        SECOND_FOLDER_NAME,
      ]) {
        await expect(mobile.getByRole('button', { name: `Open: ${name}`, exact: true })).toHaveCount(1);
      }
      await expect(mobile.locator('.entry-grid')).toHaveClass(/list/);
      const rowHeights = await entryButtons.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().height)
      );
      assert.ok(
        rowHeights.every((height) => height >= 64 && height <= 96),
        `Phone list rows must be compact touch targets, got: ${rowHeights.join(', ')}`
      );
      const textRows = await entryButtons.evaluateAll((elements) =>
        elements.map((element) => {
          const name = element.querySelector('.entry-name').getBoundingClientRect();
          const meta = element.querySelector('.entry-meta').getBoundingClientRect();
          return { nameBottom: name.bottom, metaTop: meta.top };
        })
      );
      assert.ok(
        textRows.every((row) => row.metaTop >= row.nameBottom),
        `Entry names and metadata must be on separate lines: ${JSON.stringify(textRows)}`
      );
      await mobile.getByRole('button', { name: 'Grid view', exact: true }).click();
      const phoneColumns = await poll(async () => {
        const count = await mobile.locator('.entry-grid').evaluate(
          (element) => getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length
        );
        return count === 2 ? count : null;
      }, 5_000, 'two-column phone grid');
      await capture(mobile, 'mobile-390-grid');
      await mobile.getByRole('button', { name: 'List view', exact: true }).click();
      await expect(mobile.locator('.entry-grid')).toHaveClass(/list/);
      const breadcrumbs = mobile.getByRole('navigation', { name: 'Folders', exact: true });
      await expect(breadcrumbs).toHaveCount(0);
      await mobile.getByRole('button', { name: `Open: ${NESTED_NAME}`, exact: true }).click();
      await expect(mobile.getByRole('button', { name: 'Open: inside.txt', exact: true })).toHaveCount(1);
      await expect(breadcrumbs.getByText(NESTED_NAME, { exact: true })).toHaveCount(1);
      await mobile.getByRole('button', { name: `Open: ${DEEP_FOLDER_NAME}`, exact: true }).click();
      await expect(mobile.getByRole('button', { name: 'Open: deep.txt', exact: true })).toHaveCount(1);
      await expect(breadcrumbs.getByText(NESTED_NAME, { exact: true })).toHaveCount(1);
      await expect(breadcrumbs.getByText(DEEP_FOLDER_NAME, { exact: true })).toHaveCount(1);
      await mobile.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(mobile.getByRole('button', { name: 'Open: inside.txt', exact: true })).toHaveCount(1);
      await expect(mobile.getByRole('button', { name: `Open: ${DEEP_FOLDER_NAME}`, exact: true })).toHaveCount(1);
      await expect(breadcrumbs.getByText(NESTED_NAME, { exact: true })).toHaveCount(1);
      await expect(breadcrumbs.getByText(DEEP_FOLDER_NAME, { exact: true })).toHaveCount(0);
      await breadcrumbs.getByRole('button', { name: LAN_ROOT_NAME, exact: true }).click();
      await expect(entryButtons).toHaveCount(ROOT_ENTRY_COUNT);
      await expect(breadcrumbs).toHaveCount(0);

      const search = mobile.getByRole('searchbox', { name: 'Search files and folders', exact: true });
      await search.fill('lan-note');
      await expect(entryButtons).toHaveCount(1, { timeout: 15_000 });
      await expect(mobile.getByRole('button', { name: `Open: ${NOTE_NAME}`, exact: true })).toHaveCount(1);
      await mobile.getByRole('button', { name: 'Clear search and tag filter', exact: true }).click();
      await expect(search).toHaveValue('');
      await expect(entryButtons).toHaveCount(ROOT_ENTRY_COUNT);
      return {
        rootEntries: ROOT_ENTRY_COUNT,
        phoneColumns,
        rowHeights,
        nestedDirectory: true,
        breadcrumbs: true,
        filenameSearch: true,
      };
    });

    await step('mobile-tag-text-preview-range-and-download', async () => {
      const entryButtons = mobile.locator('.entry-grid .entry-button');
      const tag = mobile.locator('.tag-filter').getByRole('button', { name: TAG, exact: true });
      await expect(tag).toHaveCount(1, { timeout: 20_000 });
      await expect(tag).toHaveAttribute('aria-pressed', 'false');
      await tag.click();
      await expect(tag).toHaveAttribute('aria-pressed', 'true');
      await expect(entryButtons).toHaveCount(1, { timeout: 15_000 });
      await expect(mobile.getByRole('button', { name: `Open: ${NOTE_NAME}`, exact: true })).toHaveCount(1);
      await expect(mobile.getByText(/until the desktop app builds its index/)).toHaveCount(0);

      const rangeResponsePromise = mobile.waitForResponse(
        (response) =>
          urlPath(response.url()) === '/api/file' &&
          response.request().headers().range === 'bytes=0-262143',
        { timeout: 20_000 }
      );
      await mobile.getByRole('button', { name: `Open: ${NOTE_NAME}`, exact: true }).click();
      const rangeResponse = await rangeResponsePromise;
      assert.equal(rangeResponse.status(), 206);
      const noteBytes = Buffer.byteLength(NOTE_CONTENT, 'utf8');
      const expectedRange = `bytes 0-${noteBytes - 1}/${noteBytes}`;
      assert.equal(await rangeResponse.headerValue('content-range'), expectedRange);
      const dialog = mobile.locator('.preview-dialog');
      await dialog.waitFor({ state: 'visible' });
      await expect(dialog.locator('#mobile-preview-title h2')).toHaveText(NOTE_NAME);
      await expect(dialog.locator('pre.text-preview-content')).toHaveText(NOTE_CONTENT);
      await expect(dialog).toHaveCSS('opacity', '1');
      await assertNoHorizontalOverflow(mobile, 'mobile 390 text preview');
      await capture(mobile, 'mobile-390-text-preview');

      const downloadPath = path.join(downloadsDirectory, NOTE_NAME);
      const downloadStatePath = path.join(downloadsDirectory, 'download-state.json');
      await dialog.getByRole('link', { name: 'Download', exact: true }).click();
      const downloadState = await poll(async () => {
        if (!fs.existsSync(downloadStatePath)) return null;
        const state = JSON.parse(fs.readFileSync(downloadStatePath, 'utf8'));
        return state.state === 'completed' ? state : null;
      }, 20_000, 'native Electron download completion');
      assert.equal(downloadState.filename, NOTE_NAME);
      assert.equal(downloadState.savePath, downloadPath);
      const downloadedUrl = new URL(downloadState.url);
      assert.equal(downloadedUrl.pathname, '/api/file');
      assert.equal(downloadedUrl.searchParams.get('download'), '1');
      assert.ok(downloadState.disposition.startsWith('attachment;'));
      assert.equal(downloadState.totalBytes, noteBytes);
      assert.equal(downloadState.receivedBytes, noteBytes);
      assert.equal(fs.readFileSync(downloadPath, 'utf8'), NOTE_CONTENT);
      assert.equal(hashFile(downloadPath), hashFile(path.join(fixtureRoot, NOTE_NAME)));
      await dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await mobile.getByRole('button', { name: 'Clear search and tag filter', exact: true }).click();
      await expect(entryButtons).toHaveCount(ROOT_ENTRY_COUNT);
      return {
        tagFilter: true,
        textPreview: true,
        range: { status: 206, contentRange: expectedRange },
        download: { suggestedFilename: NOTE_NAME, sha256: hashFile(downloadPath) },
      };
    });

    await step('mobile-image-preview-and-responsive-layouts', async () => {
      await mobile.getByRole('button', { name: `Open: ${IMAGE_NAME}`, exact: true }).click();
      const dialog = mobile.locator('.preview-dialog');
      const image = dialog.locator('img.image-preview');
      await image.waitFor({ state: 'visible' });
      const imageUrl = new URL(await image.getAttribute('src'), mobile.url()).toString();
      const imageResponse = await mobile.context().request.get(imageUrl, {
        headers: { 'X-Whale-Request': 'read-only' },
      });
      assert.equal(imageResponse.status(), 200);
      assert.equal(imageResponse.headers()['content-type'], 'image/png');
      assert.ok(imageResponse.headers()['content-disposition']?.startsWith('inline;'));
      await poll(async () => {
        const size = await image.evaluate((element) => ({
          width: element.naturalWidth,
          height: element.naturalHeight,
        }));
        return size.width === 320 && size.height === 220 ? size : null;
      }, 10_000, 'mobile image decode');
      await expect(dialog.locator('#mobile-preview-title h2')).toHaveText(IMAGE_NAME);
      await expect(dialog).toHaveCSS('opacity', '1');
      await assertNoHorizontalOverflow(mobile, 'mobile 390 image preview');
      await capture(mobile, 'mobile-390-image-preview');
      await dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
      await expect(dialog).toHaveCount(0);

      await mobileApp.evaluate(({ BrowserWindow }, options) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) throw new Error('Mobile BrowserWindow no longer exists');
        window.setContentSize(options.width, options.height);
      }, { width: 768, height: 1024 });
      await poll(async () => {
        const viewport = await mobile.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        return viewport.width === 768 && viewport.height >= 1024 && viewport.height <= 1026
          ? viewport
          : null;
      }, 10_000, 'mobile 768x1024 resize');
      await mobile.getByRole('button', { name: 'Grid view', exact: true }).click();
      await expect(mobile.locator('.entry-grid')).toHaveClass(/grid/);
      const tabletColumns = await poll(async () => {
        const count = await mobile.locator('.entry-grid').evaluate(
          (element) => getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length
        );
        return count >= 3 ? count : null;
      }, 5_000, 'multi-column tablet grid');
      await capture(mobile, 'mobile-768-grid');
      await mobile.getByRole('button', { name: 'List view', exact: true }).click();
      await expect(mobile.locator('.entry-grid')).toHaveClass(/list/);
      const geometry = await assertNoHorizontalOverflow(mobile, 'mobile 768x1024 root');
      assert.equal(geometry.viewport.width, 768);
      assert.ok(
        geometry.viewport.height >= 1024 && geometry.viewport.height <= 1026,
        `Unexpected 768px mobile viewport height: ${geometry.viewport.height}`
      );
      await capture(mobile, 'mobile-768-root');
      const afterMobile = snapshotWhale(fixtureRoot);
      assert.deepEqual(snapshotDiff(beforeLan, afterMobile), {
        created: [],
        deleted: [],
        changed: [],
      });
      return {
        imagePreview: { decoded: true, contentType: 'image/png', disposition: 'inline' },
        resizedWindow: { width: 768, height: 1024 },
        listAndGrid: true,
        tabletColumns,
        whaleUnchanged: true,
      };
    });

    await step('stop-invalidates-mobile-session', async () => {
      const dialog = await openSettings();
      await desktop.getByTestId('settings-nav-lan').click();
      await dialog.getByRole('button', { name: 'Stop LAN sharing', exact: true }).click();
      await dialog.getByRole('button', { name: 'Start LAN sharing', exact: true }).waitFor({
        state: 'visible',
        timeout: 20_000,
      });
      await expect(dialog.getByRole('button', { name: 'Copy pairing link', exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('img', { name: 'QR code for LAN pairing', exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('status').filter({ hasText: 'Stopped' })).toHaveCount(1);
      allowStoppedListDisconnect = true;
      await mobile.getByRole('button', { name: 'Refresh', exact: true }).click();
      await mobile.getByText('Could not load this content. Check the connection and try again.', { exact: true }).waitFor({
        state: 'visible',
        timeout: 20_000,
      });
      await expect(mobile.getByRole('heading', { name: 'Connect to WhaleTag', exact: true })).toHaveCount(0);
      await expect(mobile.getByRole('combobox', { name: 'Select a location', exact: true })).toHaveCount(1);
      // The stopped-state classification stays active to the end of the run:
      // the tags refresh and its console lines can trail the list failure.
      await settleDiagnostics();
      const refusedPaths = report.expectedDisconnects.map((entry) => entry.path);
      assert.ok(
        refusedPaths.includes('/api/list'),
        'Stop must make the mobile /api/list refresh fail at the closed LAN transport'
      );
      assert.ok(
        refusedPaths.every((path) => path === '/api/list' || path === '/api/tags'),
        `Unexpected mobile requests after Stop: ${refusedPaths.join(', ')}`
      );
      assert.ok(
        report.expectedDisconnects.every((entry) => entry.owner === 'mobile' && entry.method === 'GET'),
        'Only mobile GET requests may be refused after Stop'
      );
      await closeSettings(dialog);
      const afterStop = snapshotWhale(fixtureRoot);
      const diff = snapshotDiff(beforeLan, afterStop);
      assert.deepEqual(diff, { created: [], deleted: [], changed: [] });
      report.whaleAfterStop = afterStop;
      report.whaleDiff = diff;
      return { offline: true, sessionInvalidated: true, whaleUnchanged: true };
    });

    await step('unexpected-diagnostics-empty', async () => {
      assert.deepEqual(report.console, [], 'Unexpected desktop/mobile console warning or error');
      assert.deepEqual(report.pageErrors, [], 'Unexpected desktop/mobile page error');
      assert.deepEqual(report.requestFailed, [], 'Unexpected failed desktop/mobile request');
      assert.deepEqual(report.httpErrors, [], 'Unexpected HTTP error response');
      return {
        console: 0,
        pageErrors: 0,
        requestFailed: 0,
        httpErrors: 0,
        expectedConsole: report.expectedConsole.length,
        expectedDisconnects: report.expectedDisconnects.length,
      };
    });

    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.failure = { step: report.currentStep, message: redact(errorText(error)) };
    console.error(`FAIL ${report.currentStep}: ${redact(errorText(error))}`);
    if (mobile) {
      try {
        await capture(mobile, 'failure-mobile');
      } catch (captureError) {
        report.cleanupErrors.push(`Mobile failure capture: ${redact(errorText(captureError))}`);
      }
    }
    process.exitCode = 1;
  } finally {
    if (mobileApp) {
      try {
        await withTimeout(mobileApp.close(), 15_000, 'mobile Electron shutdown');
      } catch (error) {
        report.cleanupErrors.push(`Mobile Electron close: ${redact(errorText(error))}`);
        try {
          mobileApp.process().kill();
        } catch (killError) {
          report.cleanupErrors.push(`Mobile Electron kill: ${redact(errorText(killError))}`);
        }
        process.exitCode = 1;
      }
    }
    if (app && clipboardTouched && originalClipboard) {
      try {
        await app.evaluate(async ({ clipboard }, snapshot) => {
          const formatData = new Map(
            snapshot.formats.map((item) => [
              item.format,
              Buffer.from(item.data, 'base64').toString('utf8'),
            ])
          );
          clipboard.clear();
          if (formatData.has('text/html')) {
            clipboard.write({
              text: snapshot.text,
              html: formatData.get('text/html'),
            });
          } else if (formatData.has('text/plain')) {
            clipboard.writeText(snapshot.text);
          }
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const formats = clipboard.availableFormats();
            if (
              snapshot.formats.every((item) => formats.includes(item.format)) &&
              clipboard.readText() === snapshot.text
            ) return;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error('Clipboard restoration did not stabilize');
        }, originalClipboard);
      } catch (error) {
        report.cleanupErrors.push(`Clipboard restore: ${redact(errorText(error))}`);
        process.exitCode = 1;
      }
    }
    if (app) {
      try {
        await withTimeout(app.close(), 15_000, 'Electron LAN smoke shutdown');
      } catch (error) {
        report.cleanupErrors.push(`Electron close: ${redact(errorText(error))}`);
        try {
          app.process().kill();
        } catch (killError) {
          report.cleanupErrors.push(`Electron kill: ${redact(errorText(killError))}`);
        }
        process.exitCode = 1;
      }
    }
    for (const [label, directory] of [
      ['runtime profile', runtimeRoot],
      ['fixture', fixtureRoot],
    ]) {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        report.cleanupErrors.push(`${label} removal: ${redact(errorText(error))}`);
        process.exitCode = 1;
      }
    }
    if (report.cleanupErrors.length > 0) report.ok = false;
    report.finishedAt = new Date().toISOString();
    saveReport();
    if (report.ok) console.log(`Packaged LAN smoke completed. Artifacts: ${outputDirectory}`);
    else console.error(`Packaged LAN smoke failed. Redacted artifacts: ${outputDirectory}`);
  }
}

main().catch((error) => {
  console.error(redact(errorText(error)));
  process.exitCode = 1;
});
