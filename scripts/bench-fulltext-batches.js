/*
 * Source-only SQLite comparison.
 * Run: ELECTRON_RUN_AS_NODE=1 NODE_ENV=test TS_NODE_TRANSPILE_ONLY=true \
 *   electron -r ts-node/register/transpile-only -r tsconfig-paths/register \
 *   -r scripts/test-asset-stub.cjs scripts/bench-fulltext-batches.js
 */
process.env.NODE_ENV = 'test';

const path = require('node:path');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const requireModule = process.getBuiltinModule('module').createRequire(__filename);
const { median } = requireModule('./bench-stats.js');

const { insertFulltext, closeAllDbs } = requireModule('../src/main/index-db.ts');
const { searchFulltext } = requireModule('../src/main/fulltext.ts');

const COUNT = 1000;
const ROUNDS = 3;
const BATCH_SIZES = [50, 100, 200, 500, 1000];

function parseArgs(argv) {
  const options = { outputPath: '', rounds: ROUNDS };
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

function makeRows() {
  return Array.from({ length: COUNT }, (_, index) => {
    const changingToken = index < 10 ? 'whaleoldphase' : `whalestable${index % 7}`;
    const groupToken = `whalegroup${Math.floor(index / 100)}`;
    const header = `file=${index} whalecommonphase ${changingToken} ${groupToken} `;
    const relativePath = `d${String(Math.floor(index / 50)).padStart(2, '0')}/note-${String(index % 50).padStart(2, '0')}.txt`;
    return {
      path: relativePath,
      name: path.basename(relativePath),
      mtime: 1000 + index,
      content: `${header.padEnd(4095, 'x')}\n`,
    };
  });
}

async function measure(rootPath, batchSize) {
  const rows = makeRows();
  const started = performance.now();
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    await insertFulltext(rootPath, rows.slice(offset, offset + batchSize));
  }
  const elapsedMs = performance.now() - started;
  const hits = await searchFulltext(rootPath, 'whaleoldphase');
  if (hits.length !== 10) {
    throw new Error(`Expected 10 hits at batch=${batchSize}, got ${hits.length}`);
  }
  // searchFulltext caps each query at 100 rows. One group token per 100 rows
  // proves all 1000 rows were indexed without changing production query limits.
  for (let group = 0; group < COUNT / 100; group += 1) {
    const groupHits = await searchFulltext(rootPath, `whalegroup${group}`);
    if (groupHits.length !== 100) {
      throw new Error(
        `Expected 100 rows for group ${group} at batch=${batchSize}, got ${groupHits.length}`
      );
    }
  }
  return elapsedMs;
}

async function runBenchmark(options, generatedAt, hooks = {}) {
  const measureBatch = hooks.measure || measure;
  const closeDatabases = hooks.closeAllDbs || closeAllDbs;
  const removeTempRoot = hooks.removeTempRoot || ((rootPath) => fsp.rm(rootPath, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  }));
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-fulltext-batches-'));
  const results = Object.fromEntries(BATCH_SIZES.map((size) => [size, []]));
  let result;
  let tempRootRemoved = false;
  const cleanupErrors = [];
  try {
    for (let round = 0; round < options.rounds; round += 1) {
      // Alternate order so one batch size does not always receive the warmest run.
      const order = round % 2 === 0 ? BATCH_SIZES : [...BATCH_SIZES].reverse();
      for (const batchSize of order) {
        const rootPath = path.join(tempRoot, `round-${round}`, `batch-${batchSize}`);
        await fsp.mkdir(path.join(rootPath, '.whale'), { recursive: true });
        results[batchSize].push(await measureBatch(rootPath, batchSize));
        closeDatabases();
      }
    }
    result = {
      ok: true,
      schemaVersion: 1,
      generatedAt,
      platform: process.platform,
      arch: process.arch,
      rowsPerVariantPerRound: COUNT,
      bytesPerRow: 4096,
      roundCount: options.rounds,
      batchSizes: BATCH_SIZES,
      rounds: Array.from({ length: options.rounds }, (_, round) => ({
        round: round + 1,
        ...Object.fromEntries(BATCH_SIZES.map((size) => [size, results[size][round]])),
      })),
      medianMs: Object.fromEntries(
        BATCH_SIZES.map((size) => [size, median(results[size])])
      ),
      notes: [
        'Measures the real insertFulltext transaction/FTS write path only; no file reads.',
        'Batch order alternates by round; roots are new and OS page cache is not flushed.',
        'Synthetic rows validate all 1000 rows via ten 100-row group queries after each variant.',
      ],
    };
  } catch (error) {
    // Finish the same report after cleanup so a primary measurement error is
    // never replaced by a secondary database/removal failure.
    result = createFailureReport(error, generatedAt);
  } finally {
    try {
      closeDatabases();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cleanupErrors.push(`closeAllDbs: ${message}`);
      console.error('Batch benchmark database cleanup failed:', error);
      process.exitCode = 1;
    }
    try {
      await removeTempRoot(tempRoot);
      tempRootRemoved = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cleanupErrors.push(`rm: ${message}`);
      console.error(`Batch benchmark cleanup failed; temporary root remains: ${tempRoot}`, error);
      process.exitCode = 1;
    }
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
        console.error(`Batch benchmark cleanup failed: ${report.cleanupError}`);
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
        console.error('Could not write batch benchmark failure report:', reportError);
      }
    }
    console.error(error instanceof Error ? error.stack : error);
    return failure;
  }
}

if (require.main === module) void runCli();

module.exports = { parseArgs, findOutputPath, createFailureReport, writeReport, runCli };
