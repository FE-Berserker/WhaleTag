#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const executablePath = path.resolve(
  process.argv[2] || path.join(ROOT, 'release', 'build', 'win-unpacked', 'WhaleTag.exe')
);
const NEEDLE = 'whalepackagedsmokeneedle';
const expectedVersion = require('../release/app/package.json').version;

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

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('Packaged smoke currently supports Windows artifacts only');
  }
  if (!fs.existsSync(executablePath)) {
    throw new Error(
      `Packaged executable not found: ${executablePath}\n` +
        'Build it with: npm run package:win -- --dir'
    );
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-packaged-smoke-'));
  const fixtureRoot = path.join(tempRoot, 'fixture');
  const notePath = path.join(fixtureRoot, 'note.txt');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'appdata'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'local-appdata'), { recursive: true });
  fs.writeFileSync(notePath, `alpha ${NEEDLE} omega\n`, 'utf8');

  const env = {
    ...process.env,
    APPDATA: path.join(tempRoot, 'appdata'),
    LOCALAPPDATA: path.join(tempRoot, 'local-appdata'),
  };
  // A polluted developer environment otherwise turns the packaged exe into Node.
  delete env.ELECTRON_RUN_AS_NODE;

  let electronApp;
  try {
    electronApp = await electron.launch({
      executablePath,
      env,
      timeout: 30_000,
    });

    const mainStatus = await withTimeout(
      electronApp.evaluate(({ app }) => ({
        isPackaged: app.isPackaged,
        isReady: app.isReady(),
        appPath: app.getAppPath(),
        version: app.getVersion(),
      })),
      10_000,
      'main-process readiness check'
    );
    assert.equal(mainStatus.isPackaged, true);
    assert.equal(mainStatus.isReady, true);
    assert.equal(mainStatus.version, expectedVersion);
    assert.ok(
      mainStatus.appPath.endsWith(`${path.sep}app.asar`),
      `Expected an asar app path, got ${mainStatus.appPath}`
    );

    const workerResult = await withTimeout(
      electronApp.evaluate(
        async ({ utilityProcess }, { fixtureRoot, needle, workerPath }) => {
          const child = utilityProcess.fork(workerPath, [], {
            serviceName: 'whale-index-packaged-smoke',
            stdio: 'pipe',
          });

          return await new Promise((resolve, reject) => {
            const pending = new Map();
            let nextRequestId = 0;
            let done = false;

            const finish = (error, value) => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              child.removeListener('message', onMessage);
              child.removeListener('exit', onExit);
              child.kill();
              if (error) reject(error);
              else resolve(value);
            };
            const timer = setTimeout(
              () => finish(new Error('Fulltext utilityProcess timed out after 20000ms')),
              20_000
            );
            const request = (op, arg) =>
              new Promise((requestResolve, requestReject) => {
                const reqId = `packaged-smoke-${++nextRequestId}`;
                pending.set(reqId, { resolve: requestResolve, reject: requestReject });
                child.postMessage({ reqId, op, arg });
              });
            const onMessage = (message) => {
              if (message && message.kind === 'ready') {
                void run();
                return;
              }
              const requestPending = pending.get(message && message.reqId);
              if (!requestPending) return;
              pending.delete(message.reqId);
              if (message.ok) requestPending.resolve(message.result);
              else {
                requestPending.reject(
                  new Error(message.error && message.error.message
                    ? message.error.message
                    : 'Unknown utilityProcess error')
                );
              }
            };
            const onExit = (code) => {
              if (!done) finish(new Error(`Fulltext utilityProcess exited early (${code})`));
            };
            const run = async () => {
              try {
                const build = await request('fulltext:build', { rootPath: fixtureRoot });
                const search = await request('fulltext:search', {
                  rootPath: fixtureRoot,
                  q: needle,
                });
                const has = await request('fulltext:has', { rootPath: fixtureRoot });
                await request('index:shutdown', {});
                finish(null, { build, search, has });
              } catch (error) {
                finish(error);
              }
            };

            child.on('message', onMessage);
            child.on('exit', onExit);
          });
        },
        {
          fixtureRoot,
          needle: NEEDLE,
          workerPath: path.join(mainStatus.appPath, 'dist', 'main', 'index-worker.js'),
        }
      ),
      30_000,
      'packaged fulltext smoke'
    );

    assert.equal(workerResult.build.count, 1);
    assert.equal(workerResult.has, true);
    assert.equal(workerResult.search.length, 1);
    assert.equal(workerResult.search[0].path, notePath);
    assert.equal(workerResult.search[0].name, 'note.txt');
    assert.ok(workerResult.search[0].snippet.includes(NEEDLE));

    // A scanned JPEG 2000 page proves that pdfjs can load its wasm decoder
    // from app.asar.unpacked. Without wasmUrl (or without the unpacked wasm
    // directory) pdfjs drops the image but still resolves, yielding white.
    const thumbJpegBase64 = await withTimeout(
      electronApp.evaluate(
        async ({ utilityProcess }, { srcPath, workerPath }) => {
          const child = utilityProcess.fork(workerPath, [], {
            serviceName: 'whale-thumb-packaged-smoke',
            stdio: 'pipe',
          });
          const reqId = 'packaged-thumb-smoke';

          return await new Promise((resolve, reject) => {
            let done = false;
            const finish = (error, value) => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              child.removeListener('message', onMessage);
              child.removeListener('exit', onExit);
              child.kill();
              if (error) reject(error);
              else resolve(value);
            };
            const timer = setTimeout(
              () => finish(new Error('Thumbnail utilityProcess timed out after 20000ms')),
              20_000
            );
            const onMessage = (message) => {
              if (message && message.kind === 'ready') {
                child.postMessage({ reqId, op: 'thumb:pdf', arg: { srcPath } });
                return;
              }
              if (!message || message.reqId !== reqId) return;
              if (!message.ok) {
                finish(
                  new Error(
                    message.error && message.error.message
                      ? message.error.message
                      : 'Unknown thumbnail utilityProcess error'
                  )
                );
                return;
              }
              try {
                const buf = message.result && message.result.buf;
                const bytes = Buffer.from(buf && buf.type === 'Buffer' ? buf.data : buf);
                finish(null, bytes.toString('base64'));
              } catch (error) {
                finish(error);
              }
            };
            const onExit = (code) => {
              if (!done) finish(new Error(`Thumbnail utilityProcess exited early (${code})`));
            };
            child.on('message', onMessage);
            child.on('exit', onExit);
          });
        },
        {
          srcPath: path.join(ROOT, 'samples', 'pdf', 'jpx-scan.pdf'),
          workerPath: path.join(mainStatus.appPath, 'dist', 'main', 'thumb-worker.js'),
        }
      ),
      30_000,
      'packaged scanned-PDF thumbnail smoke'
    );

    const { data: pixels, info } = await sharp(
      Buffer.from(thumbJpegBase64, 'base64')
    )
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let red = 0;
    let blue = 0;
    for (let i = 0; i < pixels.length; i += info.channels) {
      if (pixels[i] > 150 && pixels[i + 1] < 100 && pixels[i + 2] < 100) red += 1;
      if (pixels[i + 2] > 150 && pixels[i] < 100 && pixels[i + 1] < 100) blue += 1;
    }
    const pixelCount = info.width * info.height;
    assert.ok(red / pixelCount > 0.3, 'Expected the red half of the JPEG 2000 scan');
    assert.ok(blue / pixelCount > 0.3, 'Expected the blue half of the JPEG 2000 scan');

    const runningApp = electronApp;
    electronApp = undefined;
    try {
      await withTimeout(runningApp.close(), 10_000, 'Electron shutdown');
    } catch (error) {
      runningApp.process().kill();
      throw error;
    }

    const persistDir = path.join(env.APPDATA, 'WhaleTag', 'persist');
    const persistFiles = fs
      .readdirSync(persistDir)
      .filter((name) => name.endsWith('.json'));
    assert.ok(persistFiles.length > 0, 'Expected isolated persisted state');
    for (const name of persistFiles) {
      JSON.parse(fs.readFileSync(path.join(persistDir, name), 'utf8'));
    }

    console.log(
      'Packaged smoke passed: main process + persisted state + utilityProcess fulltext + scanned-PDF wasm thumbnail'
    );
  } finally {
    if (electronApp) {
      try {
        await withTimeout(electronApp.close(), 10_000, 'Electron shutdown');
      } catch (error) {
        electronApp.process().kill();
        console.error('Electron shutdown failed; killed the process:', error);
        process.exitCode = 1;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
