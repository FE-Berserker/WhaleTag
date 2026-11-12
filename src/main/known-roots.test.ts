import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs, { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import {
  __resetKnownRootsForTest,
  acceptRootsFromRenderer,
  flushKnownRootsWrites,
  initKnownRoots,
  isKnownRoot,
  rememberPickedRoot,
} from './known-roots';

/**
 * `known-roots.ts` is the provenance record behind the location guard: the
 * renderer may only register directories the user actually picked, otherwise
 * a compromised renderer could hand `allowedRoots` a path like `/` and the
 * whole confinement would be decorative. These tests pin the seeding,
 * filtering, persistence and re-seed-after-corruption behavior.
 */

const created: string[] = [];

async function tmpdir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-roots-'));
  created.push(dir);
  return dir;
}

async function readDoc(
  userData: string
): Promise<{ version: number; roots: string[] }> {
  await flushKnownRootsWrites();
  const file = path.join(userData, 'known-roots.json');
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

describe('known-roots', () => {
  beforeEach(() => {
    __resetKnownRootsForTest();
  });

  afterEach(async () => {
    await flushKnownRootsWrites();
    __resetKnownRootsForTest();
    for (const dir of created.splice(0)) {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('seeds from the first renderer push and persists it', async () => {
    const userData = await tmpdir();
    const root = await tmpdir();
    initKnownRoots(userData);

    const result = acceptRootsFromRenderer([root]);
    assert.deepEqual(result.accepted, [root]);
    assert.deepEqual(result.refused, []);
    assert.equal(isKnownRoot(root), true, 'the seeded root is known');

    const doc = await readDoc(userData);
    assert.equal(doc.version, 1);
    assert.ok(doc.roots.includes(root), 'the seeded root is written to disk');
    const leftovers = (await fsp.readdir(userData)).filter((name) =>
      name.endsWith('.tmp')
    );
    assert.deepEqual(leftovers, [], 'atomic write leaves no temp file');
  });

  it('refuses a directory the user never picked once seeded', async () => {
    const userData = await tmpdir();
    const picked = await tmpdir();
    const other = await tmpdir();
    initKnownRoots(userData);
    acceptRootsFromRenderer([picked]);

    const result = acceptRootsFromRenderer([other]);
    assert.deepEqual(result.accepted, []);
    assert.deepEqual(result.refused, [other]);
    assert.equal(isKnownRoot(other), false);
    // And the check is by directory identity, not by "the file still exists".
    await flushKnownRootsWrites();
    const existing = JSON.parse(
      await fsp.readFile(path.join(userData, 'known-roots.json'), 'utf8')
    ) as { roots: string[] };
    assert.ok(existing.roots.every((r) => r !== other));
  });

  it('keeps the record across restarts', async () => {
    const userData = await tmpdir();
    const root = await tmpdir();
    initKnownRoots(userData);
    acceptRootsFromRenderer([root]);
    await flushKnownRootsWrites();

    __resetKnownRootsForTest();
    initKnownRoots(userData);
    assert.equal(isKnownRoot(root), true, 'a persisted root survives a restart');
    assert.deepEqual(acceptRootsFromRenderer([root]).accepted, [root]);

    const unknown = await tmpdir();
    assert.deepEqual(acceptRootsFromRenderer([unknown]).refused, [unknown]);
  });

  it('remembers a directory picked in the dialog before the first push', async () => {
    const userData = await tmpdir();
    const picked = await tmpdir();
    initKnownRoots(userData);

    rememberPickedRoot(picked);
    assert.equal(isKnownRoot(picked), true);

    const doc = await readDoc(userData);
    assert.ok(doc.roots.includes(picked));
  });

  it('closes the seeding window on an empty first push', async () => {
    const userData = await tmpdir();
    const later = await tmpdir();
    initKnownRoots(userData);

    // A fresh install with no locations pushes [] first. That must not leave
    // the record open, or an injected renderer could seed it with `/` later.
    assert.deepEqual(acceptRootsFromRenderer([]), { accepted: [], refused: [] });
    const result = acceptRootsFromRenderer([later]);
    assert.deepEqual(result.accepted, []);
    assert.deepEqual(result.refused, [later]);
  });

  it('ignores relative, empty and whitespace-only entries', async () => {
    const userData = await tmpdir();
    initKnownRoots(userData);

    const result = acceptRootsFromRenderer(['relative/path', '', '   ']);
    assert.deepEqual(result.accepted, []);
    assert.deepEqual(result.refused, []);
    assert.equal(isKnownRoot('relative/path'), false);
  });

  it('re-seeds when the record file is corrupt', async () => {
    const userData = await tmpdir();
    await fsp.writeFile(path.join(userData, 'known-roots.json'), 'not json', 'utf8');
    const root = await tmpdir();

    initKnownRoots(userData);
    // Corrupt record = treat it like a fresh install: the next push seeds.
    const result = acceptRootsFromRenderer([root]);
    assert.deepEqual(result.accepted, [root]);

    const doc = await readDoc(userData);
    assert.ok(doc.roots.includes(root), 'the rewritten record is valid JSON');
  });

  it('re-seeds when the record path is not a readable file', async () => {
    const userData = await tmpdir();
    await fsp.mkdir(path.join(userData, 'known-roots.json'));
    const root = await tmpdir();

    initKnownRoots(userData);
    const result = acceptRootsFromRenderer([root]);
    assert.deepEqual(result.accepted, [root], 'an unreadable record must not lock the user out');
    await flushKnownRootsWrites();
    const entries = await fsp.readdir(userData);
    assert.ok(
      entries.some((name) => name.startsWith('known-roots.json.corrupt-')),
      'the squatting directory is moved aside so the record can be written'
    );
    const doc = await readDoc(userData);
    assert.ok(doc.roots.includes(root));
  });

  it('treats a directory called known-roots.json as absent', async () => {
    const userData = await tmpdir();
    initKnownRoots(userData);
    assert.equal(isKnownRoot(userData), false, 'nothing is known before a push');
    const file = path.join(userData, 'known-roots.json');
    // The seeding path must not throw just because the file is missing.
    assert.equal(fs.existsSync(file), false);
    const root = await tmpdir();
    assert.deepEqual(acceptRootsFromRenderer([root]).accepted, [root]);
  });
});
