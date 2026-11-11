import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
import type { Pending } from './worker-protocol';

/**
 * Regression tests for the check/register/post race in both utilityProcess
 * hosts. The electron module is replaced before a fresh host module is
 * required. Wrapping the existing worker-protocol.newRequest seam exposes
 * the real private pending Map without adding production test hooks.
 */

const require_ = createRequire(__filename);
type HostKind = 'index' | 'thumb';
interface WorkerRequestMessage {
  reqId: string;
}
type PostBehavior = (
  message: WorkerRequestMessage,
  pending: Map<string, Pending>,
  child: FakeUtilityProcess
) => void;

class FakeUtilityProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();

  constructor(private readonly onPost: (message: WorkerRequestMessage) => void) {
    super();
  }

  postMessage(message: WorkerRequestMessage): void {
    this.onPost(message);
  }

  kill(): void {
    // The host clears its own child reference. No real process exists here.
  }
}

interface HostModule {
  request?: (op: 'index:status', arg: { rootPath: string }) => Promise<unknown>;
  thumbRequest?: (op: 'thumb:pdf', arg: { srcPath: string }) => Promise<Buffer>;
  killIndexWorker?: () => void;
  killThumbWorker?: () => void;
}

interface HostRig {
  send: () => Promise<unknown>;
  pending: () => Map<string, Pending> | null;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function createHostRig(kind: HostKind, onPost: PostBehavior): HostRig {
  const hostSpec = kind === 'index' ? './index-worker-host' : './thumb-worker-host';
  const hostPath = require_.resolve(hostSpec);
  const electronPath = require_.resolve('electron');
  const previousHost = require_.cache[hostPath];
  const previousElectron = require_.cache[electronPath];
  const previousRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  const protocol = require_('./worker-protocol') as typeof import('./worker-protocol');
  const originalNewRequest = protocol.newRequest;
  let pendingMap: Map<string, Pending> | null = null;

  (protocol as { newRequest: unknown }).newRequest = (
    pending: Map<string, Pending>
  ): ReturnType<typeof originalNewRequest> => {
    pendingMap = pending;
    return originalNewRequest(pending);
  };

  const child = new FakeUtilityProcess((message) => {
    if (!pendingMap) throw new Error('request was not registered before postMessage');
    onPost(message, pendingMap, child);
  });
  const electronStub = {
    utilityProcess: {
      fork: () => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
    },
  };
  require_.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: electronStub,
    children: previousElectron?.children ?? [],
    paths: previousElectron?.paths ?? [],
  } as NodeJS.Module;

  // thumbRequest normally uses its in-process fallback under the test runner;
  // this suite specifically exercises its utilityProcess transport instead.
  process.env.ELECTRON_RUN_AS_NODE = '';
  delete require_.cache[hostPath];

  let host: HostModule;
  try {
    host = require_(hostSpec) as HostModule;
  } catch (error) {
    (protocol as { newRequest: unknown }).newRequest = originalNewRequest;
    if (previousRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previousRunAsNode;
    if (previousElectron) require_.cache[electronPath] = previousElectron;
    else delete require_.cache[electronPath];
    if (previousHost) require_.cache[hostPath] = previousHost;
    else delete require_.cache[hostPath];
    throw error;
  }

  cleanups.push(() => {
    if (kind === 'index') host.killIndexWorker?.();
    else host.killThumbWorker?.();
    (protocol as { newRequest: unknown }).newRequest = originalNewRequest;
    if (previousRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previousRunAsNode;
    if (previousElectron) require_.cache[electronPath] = previousElectron;
    else delete require_.cache[electronPath];
    if (previousHost) require_.cache[hostPath] = previousHost;
    else delete require_.cache[hostPath];
  });

  return {
    send: () =>
      kind === 'index'
        ? host.request!('index:status', { rootPath: 'C:\\race' })
        : host.thumbRequest!('thumb:pdf', { srcPath: 'C:\\race.pdf' }),
    pending: () => pendingMap,
  };
}

for (const kind of ['index', 'thumb'] as const) {
  describe(`${kind} worker host postMessage races`, () => {
    it('rejects and removes the request when postMessage throws', async () => {
      const rig = createHostRig(kind, () => {
        throw new Error(`${kind} post failed`);
      });

      await assert.rejects(rig.send(), new RegExp(`${kind} post failed`));
      const pending = rig.pending();
      assert.ok(pending, 'the request should have used the real pending Map');
      assert.equal(pending.size, 0, 'a failed post must not leave a pending request');
    });

    it('settles once and stays clean when exit and post failure race', async () => {
      let rejectCount = 0;
      const rig = createHostRig(kind, (message, pending, child) => {
        const entry = pending.get(message.reqId);
        assert.ok(entry, 'the outgoing request must be pending before postMessage');
        const originalReject = entry.reject;
        entry.reject = (error: Error) => {
          rejectCount += 1;
          originalReject(error);
        };
        child.emit('exit', 23);
        throw new Error(`${kind} post failed after exit`);
      });

      await assert.rejects(
        rig.send(),
        new RegExp(`${kind} worker exited unexpectedly \\(code=23\\)`)
      );
      const pending = rig.pending();
      assert.ok(pending, 'the request should have used the real pending Map');
      assert.equal(rejectCount, 1, 'exit and catch must not reject the same entry twice');
      assert.equal(pending.size, 0, 'the exit/catch race must not leak a pending request');
    });
  });
}
