import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import benchmark from './bench-stats.js';
import performanceBenchmark from './bench-performance.js';
import batchBenchmark from './bench-fulltext-batches.js';
import phaseBenchmark from './bench-fulltext-phases.js';

const { median, summarizeTimings } = benchmark;
const { validateFulltext, validateThumbnails, verifyColdThumbnails } = performanceBenchmark;
const cliBenchmarks = [
  ['batch', batchBenchmark],
  ['phase', phaseBenchmark],
] as const;

describe('packaged performance benchmark statistics', () => {
  it('computes odd/even medians without mutating input', () => {
    const odd = [9, 1, 5];
    assert.equal(median(odd), 5);
    assert.deepEqual(odd, [9, 1, 5]);
    assert.equal(median([10, 2, 8, 4]), 6);
  });

  it('rejects empty and non-finite samples', () => {
    assert.throws(() => median([]), /median needs values/);
    assert.throws(() => median([1, Number.NaN]), /median needs finite values/);
    assert.throws(() => median([1, Infinity]), /median needs finite values/);
  });

  it('summarizes each requested timing independently', () => {
    const rounds = [
      { coldMs: 30, searchMs: 3, ignored: true },
      { coldMs: 10, searchMs: 1, ignored: true },
      { coldMs: 20, searchMs: 2, ignored: true },
    ];
    assert.deepEqual(summarizeTimings(rounds, ['coldMs', 'searchMs']), {
      coldMs: 20,
      searchMs: 2,
    });
    assert.deepEqual(rounds[0], { coldMs: 30, searchMs: 3, ignored: true });
    assert.throws(
      () => summarizeTimings([{ warmMs: 1 }, { warmMs: Number.NaN }], ['warmMs']),
      /warmMs: median needs finite values/
    );
  });
});

describe('packaged performance benchmark validation', () => {
  it('rejects incomplete fulltext hits and unavailable memory samples', () => {
    const fixtures = Array.from({ length: 3 }, () => ({
      fileCount: 1000,
      incrementalPaths: ['a.txt', 'b.txt'],
    }));
    const rounds = Array.from({ length: 3 }, () => ({
      coldCount: 1000,
      noOpCount: 1000,
      incrementalCount: 1000,
      coldSearchPaths: ['a.txt', 'b.txt'],
      searchPaths: ['a.txt', 'b.txt'],
      staleSearchCount: 0,
      has: true,
      memory: Object.fromEntries(
        ['cold', 'noOp', 'incremental', 'search'].map((phase) => [
          phase,
          { pid: 123, residentAfterPhaseKB: 10, peakSinceWorkerStartKB: 20 },
        ])
      ),
    }));
    const valid = { workerPid: 123, rounds };
    assert.doesNotThrow(() => validateFulltext(valid, fixtures));

    const brokenHit = structuredClone(valid);
    brokenHit.rounds[0].coldSearchPaths = ['a.txt'];
    assert.throws(() => validateFulltext(brokenHit, fixtures), { code: 'ERR_ASSERTION' });

    const missingMemory = structuredClone(valid);
    missingMemory.rounds[0].memory.cold.residentAfterPhaseKB = Number.NaN;
    assert.throws(() => validateFulltext(missingMemory, fixtures), /Number\.isFinite/);
  });

  it('validates thumbnail counts and JPEG artifacts, not only returned URLs', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-bench-validation-'));
    try {
      const fixtures = Array.from({ length: 3 }, (_, round) => {
        const root = path.join(tempRoot, `round-${round}`);
        const cold = path.join(root, 'cold');
        const burst = path.join(root, 'burst');
        const fixture = { coldDirectories: [cold], coalescingDirectory: burst };
        for (const directory of [cold, burst]) {
          fs.mkdirSync(path.join(directory, '.whale', 'thumbs'), { recursive: true });
          fs.writeFileSync(path.join(directory, 'image.png'), 'fixture');
          const jpeg = new Uint8Array(104);
          jpeg.set([0xff, 0xd8, 0xff]);
          fs.writeFileSync(path.join(directory, '.whale', 'wst.jpg'), jpeg);
          fs.writeFileSync(path.join(directory, '.whale', 'thumbs', 'image.png.jpg'), jpeg);
        }
        return fixture;
      });
      const rounds = Array.from({ length: 3 }, () => ({
        coldCount: 1,
        warmCount: 1,
        warmMatchesCold: true,
        sameDirResultCount: 8,
        sameDirUniqueResultCount: 1,
      }));
      assert.deepEqual(validateThumbnails(rounds, fixtures), {
        imageCount: 6,
        generatedFileCount: 12,
      });
      const broken = rounds.map((round) => ({ ...round, warmMatchesCold: false }));
      assert.throws(() => validateThumbnails(broken, fixtures), { code: 'ERR_ASSERTION' });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails cold validation when a generated artifact already exists', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-bench-cold-'));
    try {
      const cold = path.join(tempRoot, 'cold');
      const burst = path.join(tempRoot, 'burst');
      fs.mkdirSync(cold, { recursive: true });
      fs.mkdirSync(burst, { recursive: true });
      const fixtures = [{ coldDirectories: [cold], coalescingDirectory: burst }];
      assert.equal(verifyColdThumbnails(fixtures), true);
      fs.mkdirSync(path.join(cold, '.whale'), { recursive: true });
      fs.writeFileSync(path.join(cold, '.whale', 'wst.jpg'), 'stale');
      assert.throws(() => verifyColdThumbnails(fixtures), /already has a folder thumbnail/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('fulltext benchmark CLI and reports', () => {
  for (const [name, cli] of cliBenchmarks) {
    it(`${name} rejects unknown and missing arguments before running`, () => {
      assert.deepEqual(cli.parseArgs([]), { outputPath: '', rounds: 3 });
      assert.deepEqual(cli.parseArgs(['--output', 'report.json', '--rounds', '2']), {
        outputPath: path.resolve('report.json'),
        rounds: 2,
      });
      assert.throws(() => cli.parseArgs(['--unknown']), /Unknown argument: --unknown/);
      assert.throws(() => cli.parseArgs(['--output']), /--output requires a file path/);
      assert.throws(
        () => cli.parseArgs(['--output', '--rounds', '2']),
        /--output requires a file path/
      );
      assert.throws(() => cli.parseArgs(['--rounds']), /--rounds requires a value/);
      assert.throws(
        () => cli.parseArgs(['--rounds', '--output', 'report.json']),
        /--rounds requires a value/
      );
      assert.throws(() => cli.parseArgs(['--rounds', '0']), /integer between 1 and 10/);
      assert.throws(() => cli.parseArgs(['--rounds', '11']), /integer between 1 and 10/);
      for (const value of ['1.5', '1e0', '+1', ' 1', '-1', 'NaN']) {
        assert.throws(() => cli.parseArgs(['--rounds', value]), /decimal integer/);
      }
      assert.equal(
        cli.findOutputPath(['--unknown', '--output', 'failure.json']),
        path.resolve('failure.json')
      );
    });
  }

  it('overwrites stale reports with timestamped failures and creates parent directories', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-bench-report-'));
    try {
      for (const [name, cli] of cliBenchmarks) {
        const outputPath = path.join(tempRoot, name, 'nested', 'report.json');
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, '{"ok":true,"stale":true}\n', 'utf8');
        const failure = cli.createFailureReport(
          new Error(`${name} failed`),
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:01.000Z'
        );
        await cli.writeReport(outputPath, failure);
        assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), {
          ok: false,
          error: `${name} failed`,
          generatedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:01.000Z',
          tempRootRemoved: true,
        });

        const newOutputPath = path.join(tempRoot, name, 'new', 'deep', 'report.json');
        await cli.writeReport(newOutputPath, failure);
        assert.deepEqual(JSON.parse(fs.readFileSync(newOutputPath, 'utf8')), failure);
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('runs real bad argv through output discovery, parsing and failure reporting', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-bench-run-cli-'));
    try {
      for (const [name, cli] of cliBenchmarks) {
        const outputPath = path.join(tempRoot, name, 'real', 'report.json');
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, '{"ok":true,"stale":true}\n', 'utf8');
        const previousExitCode = process.exitCode;
        try {
          const returned = await cli.runCli(['--unknown', '--output', outputPath]);
          assert.equal(process.exitCode, 1);
          const report = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
          assert.deepEqual(returned, report);
          assert.equal(report.ok, false);
          assert.equal(report.error, 'Unknown argument: --unknown');
          assert.equal(report.stale, undefined);
          assert.equal(report.tempRootRemoved, true);
          const generatedAt = Date.parse(report.generatedAt);
          const completedAt = Date.parse(report.completedAt);
          assert.ok(Number.isFinite(generatedAt), `${name} generatedAt must be a timestamp`);
          assert.ok(Number.isFinite(completedAt), `${name} completedAt must be a timestamp`);
          assert.ok(completedAt >= generatedAt, `${name} completion must not precede generation`);
        } finally {
          process.exitCode = previousExitCode;
        }
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('preserves measurement errors when fixture cleanup also fails', async () => {
    const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-bench-double-failure-'));
    try {
      for (const [name, cli] of cliBenchmarks) {
        const outputPath = path.join(reportRoot, name, 'report.json');
        const measurementError = `${name} measurement failed`;
        const removalError = `${name} fixture removal failed`;
        let benchmarkRoot = '';
        const previousExitCode = process.exitCode;
        try {
          const returned = await cli.runCli(['--rounds', '1', '--output', outputPath], {
            measure: async () => {
              throw new Error(measurementError);
            },
            closeAllDbs: () => {},
            removeTempRoot: async (rootPath: string) => {
              benchmarkRoot = rootPath;
              throw new Error(removalError);
            },
          });
          assert.equal(process.exitCode, 1);
          assert.ok(benchmarkRoot, `${name} cleanup hook must receive the real fixture root`);
          assert.equal(fs.existsSync(benchmarkRoot), true);
          const report = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
          assert.deepEqual(returned, report);
          assert.equal(report.ok, false);
          assert.equal(report.error, measurementError);
          assert.equal(report.cleanupError, `rm: ${removalError}`);
          assert.equal(report.tempRootRemoved, false);
          const generatedAt = Date.parse(report.generatedAt);
          const completedAt = Date.parse(report.completedAt);
          assert.ok(Number.isFinite(generatedAt), `${name} generatedAt must be a timestamp`);
          assert.ok(Number.isFinite(completedAt), `${name} completedAt must be a timestamp`);
          assert.ok(completedAt >= generatedAt, `${name} completion must not precede generation`);
        } finally {
          process.exitCode = previousExitCode;
          if (benchmarkRoot) fs.rmSync(benchmarkRoot, { recursive: true, force: true });
        }
      }
    } finally {
      fs.rmSync(reportRoot, { recursive: true, force: true });
    }
  });
});
