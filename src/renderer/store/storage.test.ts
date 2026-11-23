import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import storage, { setPersistFailureHandler } from './storage';

interface FakeWhale {
  persistRead: (key: string) => Promise<unknown>;
  persistWrite: (key: string, value: string) => Promise<void>;
  persistDelete: (key: string) => Promise<void>;
}

const globalScope = globalThis as unknown as {
  window?: { whale: FakeWhale };
  localStorage?: { getItem: (key: string) => string | null };
};

let failures: { kind: string; error: unknown }[] = [];

function installWhale(whale: FakeWhale): void {
  globalScope.window = { whale };
}

function noopWhale(overrides: Partial<FakeWhale> = {}): FakeWhale {
  return {
    persistRead: async () => '{"ok":true}',
    persistWrite: async () => {},
    persistDelete: async () => {},
    ...overrides,
  };
}

beforeEach(() => {
  failures = [];
  setPersistFailureHandler((kind, error) => {
    failures.push({ kind, error });
  });
});

afterEach(() => {
  delete globalScope.window;
  delete globalScope.localStorage;
  setPersistFailureHandler(null);
});

describe('renderer persist storage adapter', () => {
  it('reads a string blob without reporting a failure', async () => {
    installWhale(noopWhale());
    assert.equal(await storage.getItem('whale-root'), '{"ok":true}');
    assert.deepEqual(failures, []);
  });

  it('rejects and reports a read IPC failure instead of returning null', async () => {
    const error = new Error('disk gone');
    installWhale(
      noopWhale({
        persistRead: async () => {
          throw error;
        },
      })
    );

    await assert.rejects(storage.getItem('whale-root'), /disk gone/);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].kind, 'read');
    assert.equal(failures[0].error, error);
  });

  it('rejects a non-string read result instead of feeding it to JSON.parse', async () => {
    installWhale(noopWhale({ persistRead: async () => 42 }));

    await assert.rejects(storage.getItem('whale-root'), /non-string/);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].kind, 'read');
  });

  it('reports write and delete failures and rethrows them', async () => {
    installWhale(
      noopWhale({
        persistWrite: async () => {
          throw new Error('readonly');
        },
        persistDelete: async () => {
          throw new Error('locked');
        },
      })
    );

    await assert.rejects(storage.setItem('k', 'v'), /readonly/);
    await assert.rejects(storage.removeItem('k'), /locked/);
    assert.deepEqual(
      failures.map((failure) => failure.kind),
      ['write', 'delete']
    );
  });

  it('keeps the legacy localStorage blob when migrating it fails', async () => {
    installWhale(
      noopWhale({
        persistRead: async () => null,
        persistWrite: async () => {
          throw new Error('no space');
        },
      })
    );
    globalScope.localStorage = { getItem: () => '{"legacy":1}' };

    // The legacy blob is still the user's real state: a failed migration must
    // not turn into a null (which redux-persist would treat as first run).
    assert.equal(await storage.getItem('whale-root'), '{"legacy":1}');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].kind, 'write');
  });

  it('throws without reportFailure when window.whale is unavailable', async () => {
    await assert.rejects(storage.getItem('whale-root'), /window\.whale/);
    assert.deepEqual(failures, []);
  });
});
