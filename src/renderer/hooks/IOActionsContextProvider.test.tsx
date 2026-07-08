/**
 * Tests for `importExternalCore` — the pure helper that powers
 * IOActionsContextProvider.importExternalFiles. The helper is extracted
 * from the React provider so the algorithm can be unit-tested without
 * standing up the React tree (which has act()/cleanup() inter-test
 * quirks in jsdom).
 *
 * This is the regression coverage for the Kanban / Matrix / Gantt native
 * drop bug: previously, native drops on those columns bubbled up to
 * FileList's outer drop ref, which lost the column context and stamped
 * every imported file with a today-period tag. Now each column owns its
 * tag decision via this helper, and FileList's fallback passes a
 * pre-built today-period tag for drops on empty view areas.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { importExternalCore } from './IOActionsContextProvider';

interface Recorder {
  importer: (
    sources: string[],
    destDir: string
  ) => Promise<{ copied: number; errors: string[]; importedPaths: string[] }>;
  importerCalls: Array<{ sources: string[]; destDir: string }>;
  sidecarWriter: (filePath: string, tags: string[]) => Promise<void>;
  sidecarCalls: Array<{ filePath: string; tags: string[] }>;
  sidecarImpl?: (filePath: string) => Promise<void>;
  importerResponse: { copied: number; errors: string[]; importedPaths: string[] };
  onSuccessCalls: number;
}

function makeRecorder(): Recorder {
  const r: Recorder = {
    importerCalls: [],
    sidecarCalls: [],
    sidecarWriter: (filePath, tags) => {
      r.sidecarCalls.push({ filePath, tags });
      return r.sidecarImpl ? r.sidecarImpl(filePath) : Promise.resolve();
    },
    importerResponse: { copied: 0, errors: [], importedPaths: [] },
    onSuccessCalls: 0,
    // Closure-based (not `this`-bound) so the importer doesn't lose its
    // recorder reference when called by importExternalCore as a plain
    // function value.
    importer: ((sources: string[], destDir: string) => {
      r.importerCalls.push({ sources, destDir });
      return Promise.resolve(r.importerResponse);
    }) as Recorder['importer'],
  };
  return r;
}

describe('importExternalCore', () => {
  it('calls the importer with sources + destDir', async () => {
    const r = makeRecorder();
    r.importerResponse = {
      copied: 1,
      errors: [],
      importedPaths: ['/work/foo.txt'],
    };

    const result = await importExternalCore({
      sources: ['/os/foo.txt'],
      destDir: '/work',
      tagToApply: null,
      importer: r.importer,
      sidecarWriter: r.sidecarWriter,
      onSuccess: () => undefined,
    });

    assert.deepEqual(r.importerCalls, [{ sources: ['/os/foo.txt'], destDir: '/work' }]);
    assert.deepEqual(result, r.importerResponse);
  });

  it('does NOT call sidecarWriter when tagToApply is null (Triage)', async () => {
    const r = makeRecorder();
    r.importerResponse = {
      copied: 1,
      errors: [],
      importedPaths: ['/work/x.md'],
    };

    await importExternalCore({
      sources: ['/os/x.md'],
      destDir: '/work',
      tagToApply: null,
      importer: r.importer,
      sidecarWriter: r.sidecarWriter,
    });

    assert.equal(r.sidecarCalls.length, 0);
  });

  it('does NOT call sidecarWriter when tagToApply is omitted', async () => {
    const r = makeRecorder();
    r.importerResponse = {
      copied: 1,
      errors: [],
      importedPaths: ['/work/y.md'],
    };

    await importExternalCore({
      sources: ['/os/y.md'],
      destDir: '/work',
      // tagToApply intentionally omitted
      importer: r.importer,
      sidecarWriter: r.sidecarWriter,
    });

    assert.equal(r.sidecarCalls.length, 0);
  });

  it('stamps the column tag on every imported path (Kanban / Matrix column drop)', async () => {
    const r = makeRecorder();
    r.importerResponse = {
      copied: 3,
      errors: [],
      importedPaths: ['/work/a.md', '/work/b.md', '/work/c.md'],
    };

    await importExternalCore({
      sources: ['/os/a.md', '/os/b.md', '/os/c.md'],
      destDir: '/work',
      tagToApply: 'in-progress',
      importer: r.importer,
      sidecarWriter: r.sidecarWriter,
    });

    assert.equal(r.sidecarCalls.length, 3);
    assert.deepEqual(r.sidecarCalls[0], {
      filePath: '/work/a.md',
      tags: ['in-progress'],
    });
    assert.deepEqual(r.sidecarCalls[1], {
      filePath: '/work/b.md',
      tags: ['in-progress'],
    });
    assert.deepEqual(r.sidecarCalls[2], {
      filePath: '/work/c.md',
      tags: ['in-progress'],
    });
  });

  it('stamps a today-period tag verbatim when caller asks (FileList fallback)', async () => {
    const r = makeRecorder();
    r.importerResponse = {
      copied: 1,
      errors: [],
      importedPaths: ['/work/new.md'],
    };

    await importExternalCore({
      sources: ['/os/new.md'],
      destDir: '/work',
      tagToApply: 'period:2026-07-06',
      importer: r.importer,
      sidecarWriter: r.sidecarWriter,
    });

    assert.deepEqual(r.sidecarCalls[0], {
      filePath: '/work/new.md',
      tags: ['period:2026-07-06'],
    });
  });

  it('handles a Matrix quadrant tag verbatim (Eisenhower axis)', async () => {
    const r = makeRecorder();
    r.importerResponse = {
      copied: 1,
      errors: [],
      importedPaths: ['/work/q.md'],
    };

    await importExternalCore({
      sources: ['/os/q.md'],
      destDir: '/work',
      tagToApply: 'urgent-important',
      importer: r.importer,
      sidecarWriter: r.sidecarWriter,
    });

    assert.deepEqual(r.sidecarCalls[0], {
      filePath: '/work/q.md',
      tags: ['urgent-important'],
    });
  });

  it('swallows sidecar-write failures (best-effort, never rolls back the import)', async () => {
    const r = makeRecorder();
    r.importerResponse = {
      copied: 2,
      errors: [],
      importedPaths: ['/work/good.md', '/work/bad.md'],
    };
    r.sidecarImpl = (filePath) =>
      filePath === '/work/bad.md'
        ? Promise.reject(new Error('sidecar EIO'))
        : Promise.resolve();

    // Must not throw — a sidecar failure on one file mustn't break the
    // whole import. The user sees the imported files, just without the
    // tag on the broken one.
    const result = await importExternalCore({
      sources: ['/os/good.md', '/os/bad.md'],
      destDir: '/work',
      tagToApply: 'todo',
      importer: r.importer,
      sidecarWriter: r.sidecarWriter,
    });

    assert.equal(r.sidecarCalls.length, 2);
    assert.deepEqual(result, r.importerResponse);
  });

  it('handles importedPaths being undefined (older main-process build compat)', async () => {
    const r = makeRecorder();
    r.importerResponse = {
      copied: 0,
      errors: [],
      // importedPaths missing — simulates a pre-2026-07 main-process build
      // that hasn't returned the field yet. Should not crash.
    } as { copied: number; errors: string[]; importedPaths: string[] };

    await importExternalCore({
      sources: ['/os/old.md'],
      destDir: '/work',
      tagToApply: 'todo',
      importer: r.importer,
      sidecarWriter: r.sidecarWriter,
    });

    assert.equal(r.sidecarCalls.length, 0);
  });

  it('invokes onSuccess exactly once after the import + tag loop', async () => {
    const r = makeRecorder();
    r.importerResponse = {
      copied: 1,
      errors: [],
      importedPaths: ['/work/a.md'],
    };
    let onSuccessCalls = 0;
    await importExternalCore({
      sources: ['/os/a.md'],
      destDir: '/work',
      tagToApply: 'todo',
      importer: r.importer,
      sidecarWriter: r.sidecarWriter,
      onSuccess: () => {
        onSuccessCalls += 1;
      },
    });
    assert.equal(onSuccessCalls, 1);
  });

  it('passes the tag string into normalizeSmartTags so smart-date tokens are recognized', async () => {
    const r = makeRecorder();
    r.importerResponse = {
      copied: 1,
      errors: [],
      importedPaths: ['/work/p.md'],
    };

    // `period:2026-07-06` is a smart date token — normalizeSmartTags
    // should pass it through unchanged. The exact contract lives in
    // shared/smart-tags; here we just assert the tag string survives
    // normalization without being dropped or rewritten.
    await importExternalCore({
      sources: ['/os/p.md'],
      destDir: '/work',
      tagToApply: 'period:2026-07-06',
      importer: r.importer,
      sidecarWriter: r.sidecarWriter,
    });

    const tags = r.sidecarCalls[0].tags;
    assert.equal(tags.length, 1);
    assert.equal(tags[0], 'period:2026-07-06');
  });
});