#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');
const { summarizeTimings } = require('./bench-stats.js');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_EXECUTABLE = path.join(
  ROOT,
  'release',
  'build',
  'win-unpacked',
  'WhaleTag.exe'
);
const ROUND_COUNT = 3;
const TEXT_DIRECTORIES_PER_ROUND = 20;
const TEXT_FILES_PER_DIRECTORY = 50;
const TEXT_FILE_BYTES = 4096;
const IMAGE_DIRECTORIES_PER_ROUND = 24;
const COALESCING_REQUESTS = 8;

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function roundTimings(rounds, keys) {
  return rounds.map((round) => {
    const result = { ...round };
    for (const key of keys) result[key] = rounded(result[key]);
    return result;
  });
}

function summarizeRounded(rounds, keys) {
  return Object.fromEntries(
    Object.entries(summarizeTimings(rounds, keys)).map(([key, value]) => [
      key,
      rounded(value),
    ])
  );
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

function parseArgs(argv) {
  const options = {
    executablePath: DEFAULT_EXECUTABLE,
    outputPath: null,
    only: 'all',
  };
  let positionalExecutable = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output' || arg === '--executable' || arg === '--only') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} needs a value`);
      if (arg === '--output') options.outputPath = path.resolve(value);
      else if (arg === '--executable') options.executablePath = path.resolve(value);
      else {
        if (!['all', 'fulltext', 'thumbnails'].includes(value)) {
          throw new Error('--only must be all, fulltext, or thumbnails');
        }
        options.only = value;
      }
    } else if (!positionalExecutable && !arg.startsWith('--')) {
      options.executablePath = path.resolve(arg);
      positionalExecutable = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function makeTextContent(fileIndex, commonToken, oldToken) {
  const changingToken = fileIndex < 10 ? oldToken : `whalestable${fileIndex % 7}`;
  const header = `file=${fileIndex} ${commonToken} ${changingToken} `;
  return `${header.padEnd(TEXT_FILE_BYTES - 1, 'x')}\n`;
}

function createFulltextFixture(tempRoot) {
  const fixtureRoot = path.join(tempRoot, 'fulltext-fixture');
  const rounds = [];
  for (let roundIndex = 0; roundIndex < ROUND_COUNT; roundIndex += 1) {
    const rootPath = path.join(fixtureRoot, `round-${roundIndex}`);
    const directories = [];
    const oldToken = `whaleoldround${roundIndex}`;
    const newToken = `whalenewround${roundIndex}`;
    const commonToken = `whalecommonround${roundIndex}`;
    const incrementalWrites = [];
    let fileCount = 0;
    let byteCount = 0;

    for (let directoryIndex = 0; directoryIndex < TEXT_DIRECTORIES_PER_ROUND; directoryIndex += 1) {
      const parent = directoryIndex === 0
        ? rootPath
        : directories[Math.floor((directoryIndex - 1) / 2)];
      const directory = path.join(parent, `d${String(directoryIndex).padStart(2, '0')}`);
      fs.mkdirSync(directory, { recursive: true });
      directories.push(directory);

      for (let fileIndex = 0; fileIndex < TEXT_FILES_PER_DIRECTORY; fileIndex += 1) {
        const globalIndex = directoryIndex * TEXT_FILES_PER_DIRECTORY + fileIndex;
        const filePath = path.join(directory, `note-${String(fileIndex).padStart(2, '0')}.txt`);
        const content = makeTextContent(globalIndex, commonToken, oldToken);
        assert.equal(Buffer.byteLength(content), TEXT_FILE_BYTES);
        fs.writeFileSync(filePath, content, 'utf8');
        fileCount += 1;
        byteCount += Buffer.byteLength(content);
        if (globalIndex < 10) {
          incrementalWrites.push({
            filePath,
            content: content.replace(oldToken, newToken),
          });
        }
      }
    }

    rounds.push({
      rootPath,
      oldToken,
      newToken,
      commonToken,
      incrementalWrites,
      incrementalPaths: incrementalWrites.map((write) => write.filePath),
      fileCount,
      byteCount,
      directoryCount: directories.length,
    });
  }
  return rounds;
}

async function createThumbnailFixture(tempRoot) {
  const sharp = require('sharp');
  const locationRoot = path.join(tempRoot, 'thumbnail-fixture');
  const benchmarkRoot = path.join(locationRoot, '.bench');
  const rounds = [];
  fs.mkdirSync(benchmarkRoot, { recursive: true });

  for (let roundIndex = 0; roundIndex < ROUND_COUNT; roundIndex += 1) {
    const png = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: {
          r: 40 + roundIndex * 50,
          g: 80 + roundIndex * 30,
          b: 160 - roundIndex * 30,
        },
      },
    })
      .png()
      .toBuffer();
    const roundRoot = path.join(benchmarkRoot, `round-${roundIndex}`);
    const coldDirectories = [];
    for (let index = 0; index < IMAGE_DIRECTORIES_PER_ROUND; index += 1) {
      const directory = path.join(roundRoot, `cold-${String(index).padStart(2, '0')}`);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'image.png'), png);
      coldDirectories.push(directory);
    }
    const coalescingDirectory = path.join(roundRoot, 'coalescing');
    fs.mkdirSync(coalescingDirectory, { recursive: true });
    fs.writeFileSync(path.join(coalescingDirectory, 'image.png'), png);
    rounds.push({ coldDirectories, coalescingDirectory });
  }
  return { locationRoot, rounds };
}

async function runFulltextInMain({ app, utilityProcess }, { workerPath, fixtures }) {
  // Playwright's main-process evaluator has no CommonJS `require` global.
  const fs = process.getBuiltinModule('node:fs');
  const { performance } = process.getBuiltinModule('node:perf_hooks');
  const child = utilityProcess.fork(workerPath, [], {
    serviceName: 'whale-performance-benchmark',
    // The benchmark uses the utilityProcess message channel, not stdout. Do
    // not leave verbose production logs unread in a finite pipe buffer.
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  return await new Promise((resolve, reject) => {
    const pending = new Map();
    let nextRequestId = 0;
    let done = false;
    let started = false;

    const readMemory = () => {
      if (typeof app.getAppMetrics !== 'function' || !child.pid) {
        throw new Error('Fulltext worker memory metrics are unavailable');
      }
      const metric = app.getAppMetrics().find((item) => item.pid === child.pid);
      if (!metric || !metric.memory) {
        throw new Error(`Missing memory metrics for fulltext worker ${child.pid}`);
      }
      if (
        !Number.isFinite(metric.memory.workingSetSize) ||
        !Number.isFinite(metric.memory.peakWorkingSetSize)
      ) {
        throw new Error(`Invalid memory metrics for fulltext worker ${child.pid}`);
      }
      return {
        pid: child.pid,
        residentAfterPhaseKB: metric.memory.workingSetSize,
        peakSinceWorkerStartKB: metric.memory.peakWorkingSetSize,
      };
    };
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
      () => finish(new Error('Fulltext benchmark worker timed out after 300000ms')),
      300_000
    );
    const request = (op, arg) =>
      new Promise((requestResolve, requestReject) => {
        const reqId = `performance-${++nextRequestId}`;
        pending.set(reqId, { resolve: requestResolve, reject: requestReject });
        child.postMessage({ reqId, op, arg });
      });
    const measure = async (operation) => {
      const startedAt = performance.now();
      const value = await operation();
      return { ms: performance.now() - startedAt, value, memory: readMemory() };
    };
    const onMessage = (message) => {
      if (message && message.kind === 'ready') {
        if (!started) {
          started = true;
          void run();
        }
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
      if (!done) finish(new Error(`Fulltext benchmark worker exited early (${code})`));
    };
    const run = async () => {
      try {
        const rounds = [];
        for (let index = 0; index < fixtures.length; index += 1) {
          const fixture = fixtures[index];
          const cold = await measure(() =>
            request('fulltext:build', { rootPath: fixture.rootPath })
          );
          const coldSearch = await request('fulltext:search', {
            rootPath: fixture.rootPath,
            q: fixture.oldToken,
          });
          const noOp = await measure(() =>
            request('fulltext:build', { rootPath: fixture.rootPath })
          );

          // Fixture mutation is deliberately outside the measured interval.
          for (const write of fixture.incrementalWrites) {
            fs.writeFileSync(write.filePath, write.content, 'utf8');
          }
          const incremental = await measure(() =>
            request('fulltext:build', { rootPath: fixture.rootPath })
          );
          const search = await measure(() =>
            request('fulltext:search', {
              rootPath: fixture.rootPath,
              q: fixture.newToken,
            })
          );
          const staleSearch = await request('fulltext:search', {
            rootPath: fixture.rootPath,
            q: fixture.oldToken,
          });
          const has = await request('fulltext:has', { rootPath: fixture.rootPath });
          rounds.push({
            round: index + 1,
            coldMs: cold.ms,
            noOpMs: noOp.ms,
            incrementalMs: incremental.ms,
            searchMs: search.ms,
            coldCount: cold.value.count,
            noOpCount: noOp.value.count,
            incrementalCount: incremental.value.count,
            coldSearchPaths: coldSearch.map((hit) => hit.path),
            searchPaths: search.value.map((hit) => hit.path),
            staleSearchCount: staleSearch.length,
            has,
            memory: {
              cold: cold.memory,
              noOp: noOp.memory,
              incremental: incremental.memory,
              search: search.memory,
            },
          });
        }
        await request('index:shutdown', {});
        finish(null, { workerPid: child.pid || null, rounds });
      } catch (error) {
        finish(error);
      }
    };

    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

async function runThumbnailsInRenderer({ rounds, requestCount }) {
  const { performance } = window;
  const api = window.whale;
  if (!api || typeof api.loadFolderThumbnail !== 'function') {
    throw new Error('Real renderer thumbnail IPC bridge is unavailable');
  }
  const validDataUrl = (value) =>
    typeof value === 'string' &&
    value.startsWith('data:image/jpeg;base64,') &&
    value.length > 100;
  const results = [];

  for (let index = 0; index < rounds.length; index += 1) {
    const fixture = rounds[index];
    const coldStarted = performance.now();
    const cold = await Promise.all(
      fixture.coldDirectories.map((directory) => api.loadFolderThumbnail(directory))
    );
    const coldMs = performance.now() - coldStarted;
    if (!cold.every(validDataUrl)) throw new Error('Cold thumbnail returned invalid data');

    const warmStarted = performance.now();
    const warm = await Promise.all(
      fixture.coldDirectories.map((directory) => api.loadFolderThumbnail(directory))
    );
    const warmMs = performance.now() - warmStarted;
    if (!warm.every(validDataUrl)) throw new Error('Warm thumbnail returned invalid data');

    const burstStarted = performance.now();
    const burst = await Promise.all(
      Array.from({ length: requestCount }, () =>
        api.loadFolderThumbnail(fixture.coalescingDirectory)
      )
    );
    const sameDirBurstMs = performance.now() - burstStarted;
    if (!burst.every(validDataUrl)) {
      throw new Error('Same-directory thumbnail burst returned invalid data');
    }

    results.push({
      round: index + 1,
      coldMs,
      warmMs,
      sameDirBurstMs,
      coldCount: cold.length,
      warmCount: warm.length,
      warmMatchesCold: warm.every((value, item) => value === cold[item]),
      sameDirResultCount: burst.length,
      sameDirUniqueResultCount: new Set(burst).size,
    });
  }
  return results;
}

function validateFulltext(result, fixtures) {
  assert.equal(result.rounds.length, ROUND_COUNT);
  for (let index = 0; index < fixtures.length; index += 1) {
    const fixture = fixtures[index];
    const round = result.rounds[index];
    assert.equal(round.coldCount, fixture.fileCount);
    assert.equal(round.noOpCount, fixture.fileCount);
    assert.equal(round.incrementalCount, fixture.fileCount);
    assert.equal(round.coldSearchPaths.length, fixture.incrementalPaths.length);
    assert.deepEqual(
      [...round.coldSearchPaths].sort(),
      [...fixture.incrementalPaths].sort()
    );
    assert.deepEqual([...round.searchPaths].sort(), [...fixture.incrementalPaths].sort());
    assert.equal(round.staleSearchCount, 0);
    assert.equal(round.has, true);
    for (const phase of ['cold', 'noOp', 'incremental', 'search']) {
      const memory = round.memory[phase];
      assert.equal(memory.pid, result.workerPid);
      assert.ok(Number.isFinite(memory.residentAfterPhaseKB));
      assert.ok(Number.isFinite(memory.peakSinceWorkerStartKB));
    }
  }
}

function assertJpeg(filePath) {
  const bytes = fs.readFileSync(filePath);
  assert.ok(bytes.length > 100, `Expected non-empty thumbnail: ${filePath}`);
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  assert.equal(bytes[2], 0xff);
}

function verifyColdThumbnails(fixtures) {
  for (const fixture of fixtures) {
    for (const directory of [...fixture.coldDirectories, fixture.coalescingDirectory]) {
      const folderThumbnail = path.join(directory, '.whale', 'wst.jpg');
      const fileThumbnail = path.join(directory, '.whale', 'thumbs', 'image.png.jpg');
      assert.equal(
        fs.existsSync(folderThumbnail),
        false,
        `Cold fixture already has a folder thumbnail: ${folderThumbnail}`
      );
      assert.equal(
        fs.existsSync(fileThumbnail),
        false,
        `Cold fixture already has a file thumbnail: ${fileThumbnail}`
      );
    }
  }
  return true;
}

function validateThumbnails(rounds, fixtures) {
  assert.equal(rounds.length, ROUND_COUNT);
  let imageCount = 0;
  let generatedFileCount = 0;
  for (let index = 0; index < rounds.length; index += 1) {
    const round = rounds[index];
    const fixture = fixtures[index];
    assert.equal(round.coldCount, fixture.coldDirectories.length);
    assert.equal(round.warmCount, fixture.coldDirectories.length);
    assert.equal(round.warmMatchesCold, true);
    assert.equal(round.sameDirResultCount, COALESCING_REQUESTS);
    assert.equal(round.sameDirUniqueResultCount, 1);
    for (const directory of [...fixture.coldDirectories, fixture.coalescingDirectory]) {
      const imagePath = path.join(directory, 'image.png');
      const fileThumbnail = path.join(directory, '.whale', 'thumbs', 'image.png.jpg');
      const folderThumbnail = path.join(directory, '.whale', 'wst.jpg');
      assert.ok(fs.existsSync(imagePath));
      assertJpeg(fileThumbnail);
      assertJpeg(folderThumbnail);
      imageCount += 1;
      generatedFileCount += 2;
    }
  }
  return { imageCount, generatedFileCount };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== 'win32') {
    throw new Error('Packaged performance benchmark currently supports Windows only');
  }
  if (!fs.existsSync(options.executablePath)) {
    throw new Error(`Packaged executable not found: ${options.executablePath}`);
  }

  const startedAt = new Date();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-performance-'));
  const appData = path.join(tempRoot, 'appdata');
  const tempDirectory = path.join(tempRoot, 'tmp');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'local-appdata'), { recursive: true });
  fs.mkdirSync(tempDirectory, { recursive: true });
  const env = {
    ...process.env,
    APPDATA: appData,
    LOCALAPPDATA: path.join(tempRoot, 'local-appdata'),
    TEMP: tempDirectory,
    TMP: tempDirectory,
  };
  delete env.ELECTRON_RUN_AS_NODE;

  let electronApp;
  let report;
  try {
    const fulltextFixtures = options.only === 'thumbnails'
      ? []
      : createFulltextFixture(tempRoot);
    const thumbnailFixture = options.only === 'fulltext'
      ? null
      : await createThumbnailFixture(tempRoot);

    electronApp = await electron.launch({
      executablePath: options.executablePath,
      env,
      timeout: 30_000,
    });
    const mainStatus = await withTimeout(
      electronApp.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        ready: app.isReady(),
        appPath: app.getAppPath(),
        version: app.getVersion(),
      })),
      10_000,
      'packaged main readiness'
    );
    assert.equal(mainStatus.packaged, true);
    assert.equal(mainStatus.ready, true);
    assert.ok(mainStatus.appPath.endsWith(`${path.sep}app.asar`));

    report = {
      schemaVersion: 1,
      startedAt: startedAt.toISOString(),
      executablePath: options.executablePath,
      appVersion: mainStatus.version,
      platform: process.platform,
      arch: process.arch,
      roundCount: ROUND_COUNT,
      fulltext: null,
      thumbnails: null,
      notes: [
        'Cold means a new fixture root with no index/thumbnails, not an OS page-cache flush.',
        'All fixture roots and application state are under the isolated temporary directory.',
      ],
    };

    if (options.only !== 'thumbnails') {
      const result = await withTimeout(
        electronApp.evaluate(runFulltextInMain, {
          workerPath: path.join(mainStatus.appPath, 'dist', 'main', 'index-worker.js'),
          fixtures: fulltextFixtures,
        }),
        320_000,
        'packaged fulltext benchmark'
      );
      validateFulltext(result, fulltextFixtures);
      const timingKeys = ['coldMs', 'noOpMs', 'incrementalMs', 'searchMs'];
      report.fulltext = {
        workerPid: result.workerPid,
        directoriesPerRound: TEXT_DIRECTORIES_PER_ROUND,
        filesPerRound: fulltextFixtures[0].fileCount,
        bytesPerRound: fulltextFixtures[0].byteCount,
        incrementalFilesPerRound: fulltextFixtures[0].incrementalWrites.length,
        rounds: roundTimings(result.rounds, timingKeys).map((round) => {
          const { coldSearchPaths, searchPaths, ...timings } = round;
          return {
            ...timings,
            coldSearchHitCount: coldSearchPaths.length,
            searchHitCount: searchPaths.length,
            hitPathsValidated: true,
          };
        }),
        medianMs: summarizeRounded(result.rounds, timingKeys),
        memorySemantics:
          'residentAfterPhaseKB is sampled after each awaited phase; peakSinceWorkerStartKB is cumulative for the shared worker. Snapshots are not leak evidence.',
        validation:
          'counts, cold/incremental hit paths, stale query removal, has=true, and finite per-phase worker memory passed',
      };
    }

    if (options.only !== 'fulltext') {
      const page = await withTimeout(
        electronApp.firstWindow(),
        20_000,
        'benchmark renderer window'
      );
      await withTimeout(
        page.getByText('Welcome to WhaleTag', { exact: true }).waitFor({ state: 'visible' }),
        20_000,
        'benchmark renderer UI'
      );
      await electronApp.evaluate(({ dialog }, root) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
      }, thumbnailFixture.locationRoot);
      await page.getByRole('button', { name: 'Add Location', exact: true }).last().click();
      await page.getByLabel('Location name', { exact: true }).fill('Performance benchmark');
      await page.getByRole('button', { name: 'Browse', exact: true }).click();
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await withTimeout(
        page.evaluate(async (root) => {
          await window.whale.setAllowedRoots([root]);
          // Add Location starts the same per-root build queue. Awaiting both
          // public build operations drains it before thumbnail timing starts.
          await Promise.all([
            window.whale.buildLocationIndex(root),
            window.whale.buildFulltextIndex(root),
          ]).then(([locationIndex, fulltextIndex]) => {
            if (locationIndex.count <= 0 || fulltextIndex.count !== 0) {
              throw new Error(
                `Unexpected application index counts: location=${locationIndex.count}, fulltext=${fulltextIndex.count}`
              );
            }
          });
        }, thumbnailFixture.locationRoot),
        120_000,
        'drain application index workers before thumbnail timing'
      );
      const coldVerified = verifyColdThumbnails(thumbnailFixture.rounds);

      const rounds = await withTimeout(
        page.evaluate(runThumbnailsInRenderer, {
          rounds: thumbnailFixture.rounds,
          requestCount: COALESCING_REQUESTS,
        }),
        240_000,
        'packaged thumbnail benchmark'
      );
      const validation = validateThumbnails(rounds, thumbnailFixture.rounds);
      const timingKeys = ['coldMs', 'warmMs', 'sameDirBurstMs'];
      report.thumbnails = {
        mode: 'real renderer preload IPC to packaged main thumbnail module',
        coldVerified,
        appIndexingDrained: true,
        coldDirectoriesPerRound: IMAGE_DIRECTORIES_PER_ROUND,
        sameDirBurstDirectoriesPerRound: 1,
        sameDirRequestsPerRound: COALESCING_REQUESTS,
        imageCount: validation.imageCount,
        generatedFileCount: validation.generatedFileCount,
        rounds: roundTimings(rounds, timingKeys),
        medianMs: summarizeRounded(rounds, timingKeys),
        validation:
          'all thumbnail artifacts absent before timing, application indexing drained, JPEG data URLs, warm equality, same-directory result equality, and on-disk JPEGs passed; single generation is covered by unit tests, not inferred from timing',
      };
    }

    report.completedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt.getTime();
  } finally {
    if (electronApp) {
      try {
        await withTimeout(electronApp.close(), 10_000, 'Electron shutdown');
      } catch (error) {
        const childProcess = electronApp.process();
        const exited = childProcess.exitCode !== null || childProcess.signalCode !== null
          ? null
          : withTimeout(
              new Promise((resolve) => childProcess.once('exit', resolve)),
              5_000,
              'Electron process exit after kill'
            );
        try {
          childProcess.kill();
        } catch (killError) {
          console.error('Electron kill after shutdown failure also failed:', killError);
        }
        if (exited) {
          try {
            await exited;
          } catch (exitError) {
            console.error('Bounded wait for Electron process exit failed:', exitError);
          }
        }
        // Log the close failure without throwing from finally: an earlier
        // benchmark assertion must remain the primary uncaught error.
        console.error('Electron shutdown failed; kill and bounded wait were attempted:', error);
        process.exitCode = 1;
      }
    }
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (report) report.tempRootRemoved = true;
    } catch (error) {
      if (report) report.tempRootRemoved = false;
      console.error(`Benchmark fixture cleanup failed; temporary root remains: ${tempRoot}`, error);
      process.exitCode = 1;
    }
  }

  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath) {
    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
    fs.writeFileSync(options.outputPath, output, 'utf8');
  }
  process.stdout.write(output);
}

module.exports = {
  validateFulltext,
  validateThumbnails,
  verifyColdThumbnails,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
