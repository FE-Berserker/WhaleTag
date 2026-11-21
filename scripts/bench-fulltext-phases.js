/*
 * Split the fulltext cold-build baseline into real extraction and a synthetic
 * no-read variant with the same 4KiB text shape/token count and SQLite row work. Run through Electron as
 * Node so better-sqlite3 uses the same native ABI as the application:
 *
 *   ELECTRON_RUN_AS_NODE=1 NODE_ENV=test \
 *   electron -r ts-node/register/transpile-only scripts/bench-fulltext-phases.js
 *
 * The synthetic variant is an attribution estimate, not a promise of the exact
 * post-optimization speed: it preserves the directory walk, lstat and SQLite
 * writes, but removes per-file content reads and text extraction.
 */
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
process.env.NODE_ENV = 'test';

const requireModule = process.getBuiltinModule('module').createRequire(__filename);
const { median } = requireModule('./bench-stats.js');
const { buildFulltextIndex } = requireModule('../src/main/fulltext.ts');
const { closeAllDbs } = requireModule('../src/main/index-db.ts');

const DIRECTORIES = 20;
const FILES_PER_DIRECTORY = 50;
const FILE_BYTES = 4096;

function parseArgs(argv) {
  const options = { outputPath: '', rounds: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--output') {
      if (!value || value.startsWith('--')) {
        throw new Error('--output requires a file path');
      }
      options.outputPath = path.resolve(value);
      index += 1;
    } else if (argument === '--rounds') {
      if (!value || value.startsWith('--')) {
        throw new Error('--rounds requires a value');
      }
      if (!/^\d+$/.test(value)) {
        throw new Error('--rounds must be a decimal integer between 1 and 10');
      }
      options.rounds = Number(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (options.rounds < 1 || options.rounds > 10) {
    throw new Error('--rounds must be a decimal integer between 1 and 10');
  }
  return options;
}

function findOutputPath(argv) {
  let outputPath = '';
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === '--output' && value && !value.startsWith('--')) {
      outputPath = path.resolve(value);
      index += 1;
    }
  }
  return outputPath;
}

function createFailureReport(error, generatedAt, completedAt = new Date().toISOString()) {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    generatedAt,
    completedAt,
    // Argument/reporting failures happen before a fixture root is created.
    tempRootRemoved: true,
  };
}

async function writeReport(outputPath, report) {
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function makeContents() {
  // Match bench-performance.js in 4KiB shape, token count, changing-token
  // subset and newline. Labels differ slightly between the two benchmarks.
  return Array.from({ length: DIRECTORIES * FILES_PER_DIRECTORY }, (_, index) => {
    const changingToken = index < 10 ? 'whaleoldphase' : `whalestable${index % 7}`;
    const header = `file=${index} whalecommonphase ${changingToken} `;
    return `${header.padEnd(FILE_BYTES - 1, 'x')}\n`;
  });
}

async function createCorpus(rootPath, contents) {
  const directories = [];
  const filePaths = [];
  for (let dir = 0; dir < DIRECTORIES; dir += 1) {
    const parent = dir === 0 ? rootPath : directories[Math.floor((dir - 1) / 2)];
    const directory = path.join(parent, `d${String(dir).padStart(2, '0')}`);
    await fsp.mkdir(directory, { recursive: true });
    directories.push(directory);
    await Promise.all(
      Array.from({ length: FILES_PER_DIRECTORY }, (_, local) => {
        const index = dir * FILES_PER_DIRECTORY + local;
        const filePath = path.join(directory, `note-${String(local).padStart(2, '0')}.txt`);
        filePaths[index] = filePath;
        return fsp.writeFile(filePath, contents[index]);
      })
    );
  }
  return filePaths;
}

async function measure(rootPath, contents, filePaths, extract) {
  const started = performance.now();
  const result = await buildFulltextIndex(rootPath, undefined, extract);
  const elapsedMs = performance.now() - started;
  if (result.count !== contents.length) {
    throw new Error(`Expected ${contents.length} rows, got ${result.count} under ${rootPath}`);
  }
  const hits = await searchFulltextForBenchmark(rootPath, 'whaleoldphase');
  const expected = new Set(filePaths.slice(0, 10).map((filePath) => path.resolve(filePath)));
  const actual = new Set(hits.map((hit) => path.resolve(hit.path)));
  if (hits.length !== 10 || actual.size !== 10 || [...expected].some((filePath) => !actual.has(filePath))) {
    throw new Error(`Validated hit paths diverged under ${rootPath}`);
  }
  return elapsedMs;
}

async function searchFulltextForBenchmark(rootPath, query) {
  // Kept as a small wrapper so the timing boundary is explicitly build-only.
  const { searchFulltext } = require('../src/main/fulltext.ts');
  return searchFulltext(rootPath, query);
}

async function runBenchmark(options, generatedAt, hooks = {}) {
  const measurePhase = hooks.measure || measure;
  const closeDatabases = hooks.closeAllDbs || closeAllDbs;
  const removeTempRoot = hooks.removeTempRoot || ((rootPath) => {
    fs.rmSync(rootPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-fulltext-phases-'));
  const contents = makeContents();
  const rounds = [];
  let tempRootRemoved = false;
  let failureReport;
  const cleanupErrors = [];
  try {
    for (let round = 1; round <= options.rounds; round += 1) {
      const realRoot = path.join(tempRoot, `round-${round}`, 'real');
      const syntheticRoot = path.join(tempRoot, `round-${round}`, 'synthetic');
      const realPaths = await createCorpus(realRoot, contents);
      const syntheticPaths = await createCorpus(syntheticRoot, contents);
      let syntheticCalls = 0;
      const syntheticExtractor = async (filePath) => {
        syntheticCalls += 1;
        const match = /d(\d+)[\\/]note-(\d+)\.txt$/i.exec(filePath);
        if (!match) throw new Error(`Unexpected fixture path: ${filePath}`);
        const index = Number(match[1]) * FILES_PER_DIRECTORY + Number(match[2]);
        return { text: contents[index], unreadable: false };
      };
      const measureReal = () => measurePhase(realRoot, contents, realPaths, undefined);
      const measureSynthetic = async () => {
        syntheticCalls = 0;
        const elapsedMs = await measurePhase(syntheticRoot, contents, syntheticPaths, syntheticExtractor);
        if (syntheticCalls !== contents.length) {
          throw new Error(
            `Synthetic extractor expected ${contents.length} calls, got ${syntheticCalls}; injection was not exercised`
          );
        }
        return elapsedMs;
      };
      // Alternate order across rounds to reduce systematic warm-up/order bias.
      const [realMs, syntheticNoReadMs] = round % 2 === 1
        ? [await measureReal(), await measureSynthetic()]
        : await (async () => {
            const synthetic = await measureSynthetic();
            return [await measureReal(), synthetic];
          })();
      rounds.push({
        round,
        realMs,
        syntheticNoReadMs,
        differenceMs: realMs - syntheticNoReadMs,
        files: contents.length,
        bytes: contents.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
      });
      closeDatabases();
    }
  } catch (error) {
    // Cleanup is completed below before returning a failure report. The
    // original measurement error remains primary if cleanup also fails.
    failureReport = createFailureReport(error, generatedAt);
  } finally {
    try {
      closeDatabases();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cleanupErrors.push(`closeAllDbs: ${message}`);
      console.error('Phase benchmark database cleanup failed:', error);
      process.exitCode = 1;
    }
    try {
      await removeTempRoot(tempRoot);
      tempRootRemoved = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cleanupErrors.push(`rm: ${message}`);
      console.error(`Phase benchmark cleanup failed; temporary root remains: ${tempRoot}`, error);
      process.exitCode = 1;
    }
  }
  let result;
  if (failureReport) {
    result = failureReport;
  } else {
    const realMedian = median(rounds.map((entry) => entry.realMs));
    const syntheticMedian = median(rounds.map((entry) => entry.syntheticNoReadMs));
    result = {
      ok: true,
      schemaVersion: 1,
      generatedAt,
      platform: process.platform,
      arch: process.arch,
      filesPerVariantPerRound: contents.length,
      rounds,
      medianMs: {
        real: realMedian,
        syntheticNoRead: syntheticMedian,
        difference: median(rounds.map((entry) => entry.differenceMs)),
      },
      differenceSemantics: 'median of per-round paired differences',
      differenceOfMediansMs: realMedian - syntheticMedian,
      notes: [
        'Synthetic no-read preserves directory traversal, lstat, the same 4KiB text shape/token count and SQLite FTS writes; labels differ slightly from the baseline.',
        'The difference is an attribution estimate, not a guaranteed post-optimization latency.',
        'Cold roots are new per variant/round; OS page cache is not flushed.',
      ],
    };
  }
  result.tempRootRemoved = tempRootRemoved;
  result.completedAt = new Date().toISOString();
  if (cleanupErrors.length > 0) {
    result.ok = false;
    result.cleanupError = cleanupErrors.join('; ');
    if (!result.error) result.error = result.cleanupError;
  }
  return result;
}

async function runCli(argv = process.argv.slice(2), hooks = {}) {
  const generatedAt = new Date().toISOString();
  let outputPath = '';
  try {
    outputPath = findOutputPath(argv);
    const options = parseArgs(argv);
    outputPath = options.outputPath;
    const report = await runBenchmark(options, generatedAt, hooks);
    if (outputPath) await writeReport(outputPath, report);
    if (report.ok) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.exitCode = 1;
      if (report.error && report.error !== report.cleanupError) console.error(report.error);
      if (report.cleanupError) {
        console.error(`Phase benchmark cleanup failed: ${report.cleanupError}`);
      }
    }
    return report;
  } catch (error) {
    process.exitCode = 1;
    const failure = createFailureReport(error, generatedAt);
    if (outputPath) {
      try {
        await writeReport(outputPath, failure);
      } catch (reportError) {
        console.error('Could not write phase benchmark failure report:', reportError);
      }
    }
    console.error(error instanceof Error ? error.stack : error);
    return failure;
  }
}

if (require.main === module) void runCli();

module.exports = { parseArgs, findOutputPath, createFailureReport, writeReport, runCli };
