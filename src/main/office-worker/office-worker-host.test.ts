import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';
import {
  ensureSpawned,
  request,
  isAvailable,
  killOfficeWorker,
  WorkerUnavailableError,
  __setSpawnSpecResolverForTest,
  __resetStateForTest,
} from './office-worker-host';

/**
 * Drives the host with a FAKE worker (a small node script) that speaks the
 * same JSON-line stdio protocol as `uno-worker.py`, controlled by the
 * `WHALE_FAKE_WORKER_MODE` env var so each case can exercise a different
 * branch (happy / no-ready / fatal / err / exit) without a real LibreOffice.
 *
 * Mirrors the fake-soffice shim pattern in `office-convert.test.ts`.
 */
const FAKE_WORKER_JS = `
const fs = require('fs');
const mode = process.env.WHALE_FAKE_WORKER_MODE || 'happy';
function emit(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }

if (mode === 'no-ready') {
  // Never emit ready; idle until killed (host's ready-timeout fires).
  setInterval(() => {}, 60000);
} else if (mode === 'fatal') {
  emit({ kind: 'fatal', reason: 'no-uno', message: 'test-induced' });
  setInterval(() => {}, 60000);
} else if (mode === 'exit') {
  emit({ kind: 'ready', listenerPid: process.pid });
  // Exit shortly after ready, before answering any request.
  setTimeout(() => process.exit(0), 50);
} else {
  // 'happy' or 'err' — ready, then answer each stdin request line.
  emit({ kind: 'ready', listenerPid: process.pid });
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let req;
      try { req = JSON.parse(line); } catch { continue; }
      if (mode === 'err') {
        emit({ reqId: req.reqId, ok: false, error: { name: 'Error', message: 'test conversion failure', stack: '' } });
      } else {
        try {
          fs.writeFileSync(req.outPdfPath, Buffer.from('%PDF-1.4\\nfake\\n'));
          emit({ reqId: req.reqId, ok: true });
        } catch (e) {
          emit({ reqId: req.reqId, ok: false, error: { name: 'Error', message: String(e) } });
        }
      }
    }
  });
}
`;

let tmpDir: string;
let fakeWorkerPath: string;

// Per-test ready timeout (ms). Undefined = use the host's default (10s).
let readyTimeout: number | undefined;

function setMode(mode: string): void {
  process.env.WHALE_FAKE_WORKER_MODE = mode;
}
function clearMode(): void {
  delete process.env.WHALE_FAKE_WORKER_MODE;
}

before(async () => {
  tmpDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'whale-office-worker-test-')
  );
  fakeWorkerPath = path.join(tmpDir, 'fake-worker.js');
  await fsp.writeFile(fakeWorkerPath, FAKE_WORKER_JS);
});

after(async () => {
  __resetStateForTest();
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(() => {
  __resetStateForTest();
  // Inject a spawn spec that runs the fake worker with `node`. The closure
  // reads `readyTimeout` at spawn time so each test can shrink it.
  __setSpawnSpecResolverForTest(async () => ({
    command: 'node',
    args: [fakeWorkerPath],
    cwd: tmpDir,
    readyTimeoutMs: readyTimeout,
  }));
  readyTimeout = undefined;
  clearMode();
});

describe('office-worker-host', () => {
  it('boots on ready and resolves a convert request', async () => {
    setMode('happy');
    await ensureSpawned();
    assert.ok(isAvailable(), 'available after ready');

    const out = path.join(tmpDir, 'out.pdf');
    await request(path.join(tmpDir, 'src.docx'), out);
    const data = await fsp.readFile(out);
    assert.strictEqual(data.toString('utf8', 0, 5), '%PDF-');
  });

  it('marks unavailable when the ready handshake times out', async () => {
    setMode('no-ready');
    readyTimeout = 80; // worker never emits ready -> fatal after 80ms
    await assert.rejects(
      () => ensureSpawned(),
      (e) => {
        assert.ok(e instanceof WorkerUnavailableError);
        return true;
      }
    );
    assert.ok(!isAvailable(), 'in cooldown after ready-timeout');
  });

  it('marks unavailable on a fatal envelope', async () => {
    setMode('fatal');
    await assert.rejects(
      () => ensureSpawned(),
      (e) => {
        assert.ok(e instanceof WorkerUnavailableError);
        return true;
      }
    );
    assert.ok(!isAvailable(), 'in cooldown after fatal');
  });

  it('rejects a single failed request but keeps the worker alive', async () => {
    setMode('err'); // boots fine, then answers every request with ok:false
    await ensureSpawned();
    assert.ok(isAvailable());

    await assert.rejects(
      () => request(path.join(tmpDir, 's.docx'), path.join(tmpDir, 'e.pdf')),
      (e) => {
        // Per-doc error is a plain Error, NOT WorkerUnavailableError.
        assert.ok(!(e instanceof WorkerUnavailableError));
        assert.match((e as Error).message, /test conversion failure/);
        return true;
      }
    );
    // Worker stayed available — the next request still gets answered.
    assert.ok(isAvailable());
    await assert.rejects(() =>
      request(path.join(tmpDir, 's.docx'), path.join(tmpDir, 'e2.pdf'))
    );
  });

  it('rejects pending and respawns after an unexpected exit', async () => {
    setMode('exit'); // ready, then exit ~50ms later without answering
    await ensureSpawned();
    // The in-flight request must reject (worker exited).
    await assert.rejects(
      () => request(path.join(tmpDir, 's.docx'), path.join(tmpDir, 'x.pdf')),
      (e) => {
        assert.ok(e instanceof WorkerUnavailableError);
        return true;
      }
    );
    // A single exit doesn't trip the crash threshold (MAX_BOOT_FAILURES=3),
    // so the next ensureSpawned lazily respawns.
    setMode('happy');
    await ensureSpawned();
    const out = path.join(tmpDir, 'out2.pdf');
    await request(path.join(tmpDir, 's2.docx'), out);
    assert.strictEqual((await fsp.readFile(out)).toString('utf8', 0, 5), '%PDF-');
  });

  it('killOfficeWorker clears state and allows a fresh boot', async () => {
    setMode('happy');
    await ensureSpawned();
    assert.ok(isAvailable());
    killOfficeWorker();
    // Kill does NOT set a cooldown — immediate respawn is allowed.
    assert.ok(isAvailable());
    await ensureSpawned();
    const out = path.join(tmpDir, 'out3.pdf');
    await request(path.join(tmpDir, 's3.docx'), out);
    assert.strictEqual((await fsp.readFile(out)).toString('utf8', 0, 5), '%PDF-');
  });
});
