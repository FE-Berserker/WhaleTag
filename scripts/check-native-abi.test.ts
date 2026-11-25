import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * better-sqlite3 is the one V8-bound (non-N-API) addon. Built for plain Node —
 * which is what `npm ci` installs — it fails to load inside Electron with
 * NODE_MODULE_VERSION, once per index test. The check must turn that into one
 * message that names the fix.
 */
type ProbeResult = {
  ok: boolean;
  electronAbi: string | undefined;
  builtForOtherRuntime: boolean;
  reason: string;
};
type SpawnResult = { status: number | null; stdout: string; stderr: string; error?: Error };
type Spawn = (...args: unknown[]) => SpawnResult;

const { ABI_BOUND_MODULES, checkNativeAbi, describeFailure } = require('./check-native-abi.cjs') as {
  ABI_BOUND_MODULES: string[];
  checkNativeAbi: (options?: {
    electronBin?: string;
    spawn?: Spawn;
    env?: NodeJS.ProcessEnv;
  }) => ProbeResult;
  describeFailure: (
    result: ProbeResult,
    options?: { label?: string; modules?: string[] }
  ) => string;
};

const MISMATCH_STDERR = [
  "node:internal/modules/cjs/loader:1503",
  '  throw err;',
  '  ^',
  '',
  "Error: The module '\\\\?\\C:\\repo\\node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node'",
  'was compiled against a different Node.js version using NODE_MODULE_VERSION 137.',
  'This version of Node.js requires NODE_MODULE_VERSION 146. Please try re-compiling or re-installing',
  'the module (for instance, using `npm rebuild` or `npm install`).',
  '',
  '    at Module._extensions..node (node:internal/modules/cjs/loader:1503:18)',
].join('\r\n');

describe('check-native-abi', () => {
  it('passes when every ABI-bound addon loads inside Electron', () => {
    const seen: unknown[][] = [];
    const result = checkNativeAbi({
      electronBin: 'electron.exe',
      env: { PATH: process.env.PATH ?? '' },
      spawn: (...args: unknown[]) => {
        seen.push(args);
        return { status: 0, stdout: '146\n', stderr: '' };
      },
    });
    assert.deepEqual(result, { ok: true, electronAbi: '146', builtForOtherRuntime: false, reason: '' });
    const [command, argv, options] = seen[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    assert.equal(command, 'electron.exe');
    assert.equal(argv[0], '-e');
    for (const name of ABI_BOUND_MODULES) assert.ok(argv[1].includes(`require("${name}");`), name);
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1', 'the probe runs Electron as Node');
  });

  it('names the rebuild fix when the addon was built for plain Node', () => {
    const result = checkNativeAbi({
      electronBin: 'electron.exe',
      spawn: () => ({ status: 1, stdout: '', stderr: MISMATCH_STDERR }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.builtForOtherRuntime, true);
    assert.match(result.reason, /NODE_MODULE_VERSION 137/);
    const text = describeFailure(result, { label: 'run-tests' });
    assert.match(text, /^run-tests: a native module cannot be loaded by this Electron\./);
    assert.ok(text.includes('better-sqlite3: '), 'the failing module is named');
    assert.ok(text.includes('npx electron-rebuild -f -o better-sqlite3'), 'and so is the fix');
  });

  it('reports a probe that fails for another reason without inventing a rebuild hint', () => {
    const result = checkNativeAbi({
      electronBin: 'electron.exe',
      spawn: () => ({ status: null, stdout: '', stderr: 'Error: DLL initialization routine failed', error: undefined }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.builtForOtherRuntime, false);
    assert.equal(result.reason, 'Error: DLL initialization routine failed');
    assert.ok(!describeFailure(result).includes('electron-rebuild'));
    const notStarted = checkNativeAbi({
      electronBin: 'electron.exe',
      spawn: () => ({
        status: null,
        stdout: '',
        stderr: '',
        error: Object.assign(new Error('spawn electron.exe ENOENT'), { code: 'ENOENT' }),
      }),
    });
    assert.equal(notStarted.ok, false);
    assert.match(notStarted.reason, /could not start Electron: spawn electron\.exe ENOENT/);
  });

  it('loads better-sqlite3 with the Electron that runs this test', () => {
    // `process.execPath` is electron.exe under `electron --test`: the real
    // probe, with nothing mocked, must agree with the running ABI.
    const result = checkNativeAbi({ electronBin: process.execPath });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.electronAbi, process.versions.modules);
  });
});
