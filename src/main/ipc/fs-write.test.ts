import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { existsSync, promises as fsp } from 'fs';
import type { ExecFileOptions } from 'child_process';

import { setAllowedRoots, setReadOnlyRoots } from '../allowed-roots';
import {
  commonParentDir,
  copyEntry,
  createTextFile,
  deletePath,
  moveEntry,
  runOsZip,
  type OsZipRunner,
} from './fs-write';

describe('fs-write createTextFile', () => {
  it('rejects an existing file without changing its bytes', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-fs-write-'));
    const root = await fsp.realpath(scratch);
    const file = path.join(root, 'existing.txt');
    setAllowedRoots([root]);
    try {
      await fsp.writeFile(file, 'original', 'utf8');
      await assert.rejects(
        createTextFile(file, 'replacement'),
        /File already exists/
      );
      assert.equal(await fsp.readFile(file, 'utf8'), 'original');
    } finally {
      setAllowedRoots([]);
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });

  it('allows only one winner when concurrent creates target the same path', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-fs-write-'));
    const root = await fsp.realpath(scratch);
    const file = path.join(root, 'race.txt');
    setAllowedRoots([root]);
    try {
      const results = await Promise.allSettled([
        createTextFile(file, 'first'),
        createTextFile(file, 'second'),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
      assert.ok(['first', 'second'].includes(await fsp.readFile(file, 'utf8')));
    } finally {
      setAllowedRoots([]);
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });
});

/**
 * The approval dialog serializes only one call at a time, but MCP clients can
 * issue parallel calls. Two copies/moves that both pass the "destination does
 * not exist" check must not silently replace each other (merge-over-wipe).
 */
describe('fs-write concurrent copies/moves to one destination', () => {
  it('lets exactly one concurrent copy win and never overwrites the loser', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-fs-write-'));
    const root = await fsp.realpath(scratch);
    setAllowedRoots([root]);
    try {
      const a = path.join(root, 'a.txt');
      const b = path.join(root, 'b.txt');
      const dest = path.join(root, 'out.txt');
      await fsp.writeFile(a, 'AAAA', 'utf8');
      await fsp.writeFile(b, 'BBBB', 'utf8');

      const results = await Promise.allSettled([
        copyEntry(a, dest),
        copyEntry(b, dest),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
      // Whichever won, the destination holds that source's exact bytes.
      assert.ok(['AAAA', 'BBBB'].includes(await fsp.readFile(dest, 'utf8')));
    } finally {
      setAllowedRoots([]);
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });

  it('lets exactly one concurrent move win and keeps both sources otherwise', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-fs-write-'));
    const root = await fsp.realpath(scratch);
    setAllowedRoots([root]);
    try {
      const a = path.join(root, 'a.txt');
      const b = path.join(root, 'b.txt');
      const dest = path.join(root, 'moved.txt');
      await fsp.writeFile(a, 'AAAA', 'utf8');
      await fsp.writeFile(b, 'BBBB', 'utf8');

      const results = await Promise.allSettled([
        moveEntry(a, dest),
        moveEntry(b, dest),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled').length;
      assert.equal(won, 1);
      // Exactly one source disappeared; the other is untouched.
      const survivors = [a, b].filter((p) => existsSync(p));
      assert.equal(survivors.length, 1);
      // The destination holds the bytes of the source that MOVED, not the one
      // that stayed — so derive the expected content from the missing source.
      assert.equal(await fsp.readFile(dest, 'utf8'), survivors[0] === a ? 'BBBB' : 'AAAA');
    } finally {
      setAllowedRoots([]);
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });

  it('refuses to replace an existing destination and keeps its bytes', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-fs-write-'));
    const root = await fsp.realpath(scratch);
    setAllowedRoots([root]);
    try {
      const src = path.join(root, 'src.txt');
      const dest = path.join(root, 'keep.txt');
      await fsp.writeFile(src, 'SOURCE', 'utf8');
      await fsp.writeFile(dest, 'KEEP', 'utf8');

      await assert.rejects(copyEntry(src, dest), /file already exists/i);
      assert.equal(await fsp.readFile(dest, 'utf8'), 'KEEP');
    } finally {
      setAllowedRoots([]);
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });
});

/**
 * `fs.cp` walks its own output when a folder is copied into its subtree, and
 * the cross-device move fallback removes the source it is copying from. The
 * renderer refuses such targets, but the MCP tools build the destination from
 * agent-supplied paths — the main process must refuse on its own.
 */
describe('fs-write — a folder is never moved or copied into itself', () => {
  it('refuses to copy a folder into its own subtree and leaves the tree as it was', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-fs-write-'));
    const root = await fsp.realpath(scratch);
    setAllowedRoots([root]);
    try {
      const folder = path.join(root, 'photos');
      await fsp.mkdir(path.join(folder, 'sub'), { recursive: true });
      await fsp.writeFile(path.join(folder, 'sub', 'a.txt'), 'A', 'utf8');

      await assert.rejects(
        copyEntry(folder, path.join(folder, 'sub', 'photos')),
        /cannot be moved or copied into itself/
      );
      // One level, or deeper: both are refused before anything is created.
      await assert.rejects(
        copyEntry(folder, path.join(folder, 'sub', 'x', 'y', 'photos')),
        /cannot be moved or copied into itself/
      );
      assert.deepEqual((await fsp.readdir(path.join(folder, 'sub'))).sort(), ['a.txt']);
    } finally {
      setAllowedRoots([]);
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });

  it('refuses to move a folder into its own subtree and keeps it where it was', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-fs-write-'));
    const root = await fsp.realpath(scratch);
    setAllowedRoots([root]);
    try {
      const folder = path.join(root, 'docs');
      await fsp.mkdir(path.join(folder, 'nested'), { recursive: true });
      await fsp.writeFile(path.join(folder, 'nested', 'n.md'), '# n', 'utf8');

      await assert.rejects(
        moveEntry(folder, path.join(folder, 'nested', 'docs')),
        /cannot be moved or copied into itself/
      );
      assert.equal(
        await fsp.readFile(path.join(folder, 'nested', 'n.md'), 'utf8'),
        '# n'
      );
      assert.deepEqual(await fsp.readdir(path.join(folder, 'nested')), ['n.md']);
    } finally {
      setAllowedRoots([]);
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });

  it('does not get in the way of an ordinary move or copy next to the source', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-fs-write-'));
    const root = await fsp.realpath(scratch);
    setAllowedRoots([root]);
    try {
      const folder = path.join(root, 'photos');
      const target = path.join(root, 'target');
      await fsp.mkdir(folder);
      await fsp.mkdir(target);
      await fsp.writeFile(path.join(folder, 'a.txt'), 'A', 'utf8');

      // Into a sibling folder, and with a similar name beside the source:
      // neither is inside the source, both must go through.
      await copyEntry(folder, path.join(target, 'photos'));
      await moveEntry(path.join(target, 'photos'), path.join(root, 'photos-backup'));
      assert.equal(await fsp.readFile(path.join(root, 'photos-backup', 'a.txt'), 'utf8'), 'A');
      // A file has no subtree: the guard never applies to it.
      await moveEntry(
        path.join(root, 'photos-backup', 'a.txt'),
        path.join(folder, 'renamed.txt')
      );
      assert.equal(await fsp.readFile(path.join(folder, 'renamed.txt'), 'utf8'), 'A');
    } finally {
      setAllowedRoots([]);
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });
});

describe('fs-write commonParentDir', () => {
  const base = path.resolve(os.tmpdir(), 'whale-zip-plan');

  it('uses the shared folder when all sources are siblings', () => {
    const dir = path.join(base, 'a');
    assert.equal(commonParentDir([path.join(dir, 'x.txt'), path.join(dir, 'y.txt')]), dir);
  });

  it('walks up to the common ancestor for sources in different folders', () => {
    const sources = [
      path.join(base, 'a', 'x.txt'),
      path.join(base, 'b', 'y.txt'),
      path.join(base, 'b', 'c', 'z.txt'),
    ];
    assert.equal(commonParentDir(sources), base);
  });

  it('handles a single source (its own folder) and relative input', () => {
    const single = path.join(base, 'a', 'x.txt');
    assert.equal(commonParentDir([single]), path.dirname(single));
    assert.equal(commonParentDir([path.relative(process.cwd(), single)]), path.dirname(single));
  });

  it('rejects an empty selection', () => {
    assert.throws(() => commonParentDir([]), /at least one path/);
  });
});

describe('fs-write bounded OS zip processes', () => {
  function assertProcessLimits(options: ExecFileOptions): void {
    assert.equal(options.timeout, 120_000);
    assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(options.maxBuffer, 1024 * 1024);
  }

  function invocationArchive(file: string, args: string[]): string {
    if (file === 'zip') return args[2];
    if (file === 'python3') return args[3];
    const match = / -DestinationPath '((?:[^']|'')+)'$/.exec(args[3]);
    assert.ok(match, 'PowerShell invocation contains a staging destination');
    return match[1].replace(/''/g, "'");
  }

  it('applies the limits to PowerShell and resolves only after creating the archive', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-os-zip-'));
    try {
      const source = path.join(scratch, "O'Brien.txt");
      const archive = path.join(scratch, 'out.zip');
      const calls: Array<{ file: string; args: string[]; options: ExecFileOptions }> = [];
      const runner: OsZipRunner = async (file, args, options) => {
        calls.push({ file, args, options });
        await fsp.writeFile(invocationArchive(file, args), 'PK\u0003\u0004');
      };

      assert.equal(await runOsZip([source], archive, runner, 'win32'), archive);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].file, 'powershell.exe');
      assert.ok(calls[0].args[3].includes("O''Brien.txt'"));
      assertProcessLimits(calls[0].options);
      const staging = invocationArchive(calls[0].file, calls[0].args);
      assert.notEqual(staging, archive, 'OS tool never writes the final path directly');
      assert.ok(staging.endsWith('.zip'), 'PowerShell staging name keeps a .zip suffix');
      assert.equal(existsSync(staging), false, 'successful rename leaves no staging file');
      assert.equal(existsSync(archive), true);
    } finally {
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });

  it('surfaces a PowerShell timeout instead of resolving without an archive', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-os-zip-'));
    try {
      const expected = new Error('PowerShell process timed out');
      const archive = path.join(scratch, 'out.zip');
      let staging = '';
      const runner: OsZipRunner = async (file, args, options) => {
        assertProcessLimits(options);
        staging = invocationArchive(file, args);
        await fsp.writeFile(staging, 'partial archive');
        throw expected;
      };
      await assert.rejects(
        runOsZip([path.join(scratch, 'input')], archive, runner, 'win32'),
        (error: unknown) => {
          assert.equal(error, expected);
          return true;
        }
      );
      assert.ok(staging.includes('out.zip.tmp-'));
      assert.equal(existsSync(staging), false, 'failed attempt removes its partial archive');
      assert.equal(existsSync(archive), false, 'failed attempt never publishes the final path');
    } finally {
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });

  it('bounds zip and python3 while preserving the relative archive layout', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-os-zip-'));
    try {
      const sources = [
        path.join(scratch, 'a', 'x.txt'),
        path.join(scratch, 'b', 'y.txt'),
      ];
      const archive = path.join(scratch, 'out.zip');
      const calls: Array<{ file: string; args: string[]; options: ExecFileOptions }> = [];
      const runner: OsZipRunner = async (file, args, options) => {
        calls.push({ file, args, options });
        if (file === 'zip') {
          throw Object.assign(new Error('zip is unavailable'), { code: 'ENOENT' });
        }
        await fsp.writeFile(invocationArchive(file, args), 'PK\u0003\u0004');
      };

      assert.equal(await runOsZip(sources, archive, runner, 'linux'), archive);
      assert.deepEqual(calls.map((call) => call.file), ['zip', 'python3']);
      for (const call of calls) {
        assertProcessLimits(call.options);
        assert.equal(call.options.cwd, scratch);
      }
      const staging = invocationArchive(calls[0].file, calls[0].args);
      assert.deepEqual(calls[0].args, [
        '-r',
        '-q',
        staging,
        path.join('a', 'x.txt'),
        path.join('b', 'y.txt'),
      ]);
      assert.deepEqual(JSON.parse(calls[1].args[2]), [
        [sources[0], path.join('a', 'x.txt')],
        [sources[1], path.join('b', 'y.txt')],
      ]);
      assert.equal(calls[1].args[3], staging);
      assert.notEqual(staging, archive);
      assert.equal(existsSync(staging), false);
      assert.equal(existsSync(archive), true);
    } finally {
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });

  it('never hands the zip CLI a source that reads as an option', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-os-zip-'));
    try {
      // A folder literally called `-r` would otherwise reach `zip` as a switch.
      const sources = [
        path.join(scratch, '-r', 'a.txt'),
        path.join(scratch, 'b', 'c.txt'),
      ];
      const calls: Array<{ file: string; args: string[] }> = [];
      const runner: OsZipRunner = async (file, args) => {
        calls.push({ file, args });
        await fsp.writeFile(invocationArchive(file, args), 'PK\u0003\u0004');
      };

      assert.equal(
        await runOsZip(sources, path.join(scratch, 'out.zip'), runner, 'linux'),
        path.join(scratch, 'out.zip')
      );
      assert.deepEqual(calls[0].args.slice(3), [
        `./${path.join('-r', 'a.txt')}`,
        path.join('b', 'c.txt'),
      ]);
    } finally {
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });

  it('rejects a timed-out python3 fallback with the underlying detail', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-os-zip-'));
    try {
      const runner: OsZipRunner = async (file, _args, options) => {
        assertProcessLimits(options);
        if (file === 'zip') {
          throw Object.assign(new Error('zip is unavailable'), { code: 'ENOENT' });
        }
        throw new Error('python3 process timed out');
      };
      await assert.rejects(
        runOsZip([path.join(scratch, 'input')], path.join(scratch, 'out.zip'), runner, 'linux'),
        /python3 fallback failed: python3 process timed out/
      );
      assert.equal(existsSync(path.join(scratch, 'out.zip')), false);
    } finally {
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });

  it('maps process-limit errors without echoing source paths and cleans staging', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-os-zip-'));
    try {
      const source = path.join(scratch, 'private-input.txt');
      const archive = path.join(scratch, 'out.zip');
      const cases = [
        {
          error: Object.assign(new Error(`Command failed with ${source}`), {
            killed: true,
            signal: 'SIGKILL',
          }),
          message: 'ZIP packaging timed out after 120 seconds.',
        },
        {
          error: Object.assign(new Error(`stdout maxBuffer length exceeded ${source}`), {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          }),
          message: 'ZIP packaging output exceeded the 1 MiB limit.',
        },
      ];
      for (const testCase of cases) {
        const runner: OsZipRunner = async (file, args) => {
          await fsp.writeFile(invocationArchive(file, args), 'partial');
          throw testCase.error;
        };
        await assert.rejects(runOsZip([source], archive, runner, 'win32'), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, testCase.message);
          assert.equal(error.message.includes(source), false, 'user error hides raw argv');
          return true;
        });
        assert.equal(existsSync(archive), false);
      }
      assert.deepEqual(
        (await fsp.readdir(scratch)).filter((name) => name.includes('.tmp-')),
        [],
        'both limit failures clean their staging files'
      );
    } finally {
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });

  it('creates a real short archive through the default bounded runner', async () => {
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-os-zip-'));
    try {
      const source = path.join(scratch, 'source');
      const archive = path.join(scratch, 'out.zip');
      await fsp.mkdir(source);
      await fsp.writeFile(path.join(source, 'hello.txt'), 'hello', 'utf8');

      assert.equal(await runOsZip([source], archive), archive);
      const bytes = await fsp.readFile(archive);
      assert.ok(bytes.length > 4);
      assert.equal(bytes.subarray(0, 2).toString(), 'PK');
    } finally {
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });
});

describe('read-only locations reject writes', () => {
  it('refuses create, move-in, copy-in and delete inside a read-only root', async () => {
    const locked = await fsp.realpath(
      await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-ro-locked-'))
    );
    const writable = await fsp.realpath(
      await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-ro-writable-'))
    );
    setAllowedRoots([locked, writable]);
    setReadOnlyRoots([locked]);
    try {
      const source = path.join(writable, 'source.txt');
      await fsp.writeFile(source, 'payload', 'utf8');
      const existing = path.join(locked, 'existing.txt');
      await fsp.writeFile(existing, 'keep me', 'utf8');

      // The read-only flag is enforced by the main process, so the refusal
      // holds even for a renderer (or MCP client) that forgot to check.
      await assert.rejects(
        createTextFile(path.join(locked, 'new.txt'), 'x'),
        /read-only/
      );
      await assert.rejects(
        moveEntry(source, path.join(locked, 'moved.txt')),
        /read-only/
      );
      assert.equal(existsSync(source), true, 'a refused move keeps its source');
      await assert.rejects(
        copyEntry(source, path.join(locked, 'copied.txt')),
        /read-only/
      );
      await assert.rejects(deletePath(existing, false), /read-only/);
      assert.equal(existsSync(existing), true, 'a refused delete keeps the file');
      assert.equal(existsSync(path.join(locked, 'new.txt')), false);
    } finally {
      setReadOnlyRoots([]);
      setAllowedRoots([]);
      await fsp.rm(locked, { recursive: true, force: true });
      await fsp.rm(writable, { recursive: true, force: true });
    }
  });
});
