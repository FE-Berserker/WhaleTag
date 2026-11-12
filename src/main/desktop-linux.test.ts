import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  launchLinuxTerminal,
  linuxRevealSteps,
  linuxTerminalCandidates,
  pythonZipPairs,
  type SpawnedChild,
  type SpawnLike,
} from './desktop-linux';

/**
 * Fake spawn: records argv, emits `spawn` for working binaries and `error`
 * (ENOENT) for the ones in `failing`. Mirrors Node's async spawn contract —
 * the caller must wait for the event before treating a child as started.
 */
function fakeSpawn(
  failing: ReadonlySet<string>,
  calls: Array<{ bin: string; args: string[] }>,
  unrefed: string[]
): SpawnLike {
  return (bin, args) => {
    calls.push({ bin, args });
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const child = {
      on(event: string, listener: (...args: unknown[]) => void) {
        (listeners[event] ??= []).push(listener);
        queueMicrotask(() => {
          if (event === 'spawn' && !failing.has(bin)) listener();
          if (event === 'error' && failing.has(bin)) {
            listener(new Error(`spawn ${bin} ENOENT`));
          }
        });
        return child;
      },
      unref() {
        unrefed.push(bin);
      },
    };
    return child as unknown as SpawnedChild;
  };
}

describe('desktop-linux terminal fallback', () => {
  it('orders $TERMINAL first and xterm last', () => {
    const bins = linuxTerminalCandidates({ TERMINAL: 'my-term' }).map(
      (c) => c.bin
    );
    assert.equal(bins[0], 'my-term');
    assert.equal(bins.at(-1), 'xterm');
    assert.ok(bins.includes('gnome-terminal'));
    assert.ok(bins.includes('konsole'));
    assert.ok(bins.includes('xfce4-terminal'));
  });

  it('ignores a blank $TERMINAL', () => {
    const bins = linuxTerminalCandidates({ TERMINAL: '   ' }).map((c) => c.bin);
    assert.equal(bins[0], 'x-terminal-emulator');
  });

  it('passes the program argv in the shape each terminal expects', () => {
    const byBin = new Map(
      linuxTerminalCandidates({}).map((c) => [c.bin, c])
    );
    assert.deepEqual(byBin.get('gnome-terminal')?.argsFor('echo hi'), [
      '--',
      'bash',
      '-lc',
      'echo hi',
    ]);
    assert.deepEqual(byBin.get('xfce4-terminal')?.argsFor('echo hi'), [
      '-x',
      'bash',
      '-lc',
      'echo hi',
    ]);
    assert.deepEqual(byBin.get('kitty')?.argsFor('echo hi'), [
      'bash',
      '-lc',
      'echo hi',
    ]);
    assert.deepEqual(byBin.get('xterm')?.argsFor('echo hi'), [
      '-e',
      'bash',
      '-lc',
      'echo hi',
    ]);
  });

  it('skips terminals whose binary is missing and returns the first that spawns', async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const unrefed: string[] = [];
    const candidates = linuxTerminalCandidates({});
    const started = await launchLinuxTerminal(
      'echo hi; exec bash',
      candidates,
      fakeSpawn(new Set(['x-terminal-emulator', 'gnome-terminal']), calls, unrefed)
    );
    assert.equal(started, 'konsole');
    assert.deepEqual(
      calls.map((c) => c.bin),
      ['x-terminal-emulator', 'gnome-terminal', 'konsole']
    );
    assert.deepEqual(unrefed, ['konsole']);
    // The keep-the-window-open suffix travels with the command (the caller
    // appended it), and every candidate receives the same command line.
    assert.equal(calls[2].args.at(-1), 'echo hi; exec bash');
  });

  it('throws listing every attempted binary when no terminal is available', async () => {
    const all = linuxTerminalCandidates({}).map((c) => c.bin);
    await assert.rejects(
      launchLinuxTerminal(
        'echo hi',
        linuxTerminalCandidates({}),
        fakeSpawn(new Set(all), [], [])
      ),
      (error: Error) => {
        assert.match(error.message, /No terminal emulator could be launched/);
        for (const bin of all) {
          assert.ok(
            error.message.includes(`${bin}:`),
            `expected the failure list to mention ${bin}`
          );
        }
        return true;
      }
    );
  });
});

describe('desktop-linux reveal steps', () => {
  it('asks D-Bus first, then select-capable managers, then xdg-open', () => {
    const target = path.join('home', 'u', 'My Photos', 'a b.png');
    const steps = linuxRevealSteps(target);
    assert.deepEqual(
      steps.map((s) => s.bin),
      ['dbus-send', 'nautilus', 'dolphin', 'xdg-open']
    );
    const dbus = steps[0].args;
    assert.equal(dbus[1], '--dest=org.freedesktop.FileManager1');
    assert.equal(dbus[4], 'org.freedesktop.FileManager1.ShowItems');
    // The file URI is encoded — spaces must not reach dbus-send verbatim.
    assert.equal(dbus[5], `array:string:${pathToFileURL(target).href}`);
    assert.ok(dbus[5].includes('%20'));
    assert.deepEqual(steps[1].args, ['--select', target]);
    assert.deepEqual(steps[3].args, [path.dirname(target)]);
  });
});

describe('desktop-linux python zip fallback', () => {
  it('stores entries relative to the shared parent', () => {
    const cwd = path.resolve('/data/root');
    const sources = [
      path.resolve('/data/root/a.txt'),
      path.resolve('/data/root/sub'),
    ];
    const pairs = pythonZipPairs(sources, cwd);
    assert.deepEqual(pairs, [
      [path.resolve('/data/root/a.txt'), 'a.txt'],
      [path.resolve('/data/root/sub'), 'sub'],
    ]);
  });

  it('keeps cross-folder relative layout (no basename collapsing)', () => {
    const cwd = path.resolve('/data');
    const pairs = pythonZipPairs(
      [path.resolve('/data/a/one.txt'), path.resolve('/data/b/two.txt')],
      cwd
    );
    assert.deepEqual(
      pairs.map((p) => p[1]),
      [path.join('a', 'one.txt'), path.join('b', 'two.txt')]
    );
  });
});
