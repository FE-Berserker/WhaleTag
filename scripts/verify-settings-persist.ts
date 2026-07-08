/**
 * Automated dev-environment verification that redux-persist settings survive
 * an app restart. Flow:
 *   1. Start webpack dev server on :4002.
 *   2. Launch Electron pointed at dev server with remote-debugging-port=9223.
 *   3. Via Chrome DevTools Protocol, read current themeMode.
 *   4. Dispatch setThemeMode('dark') through the exposed window.__WHALE_STORE__.
 *   5. Gracefully close the window (triggers our main-process flush hook).
 *   6. Relaunch Electron.
 *   7. Read themeMode again; expect 'dark'.
 *
 * Run with:
 *   npx cross-env TS_NODE_TRANSPILE_ONLY=true node -r ts-node/register -r tsconfig-paths/register scripts/verify-settings-persist.ts
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';

// Use cross-spawn for better Windows .cmd handling.
const crossSpawn = require('cross-spawn');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEV_PORT = 4002;
const CDP_PORT = 9223;
const USER_DATA_DIR = path.join(PROJECT_ROOT, '.tmp-persist-test');
try {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
} catch {
  // ignore
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPort(port: number, timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(`http://localhost:${port}/`, (res) => {
        resolve(res.statusCode !== undefined);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await sleep(500);
  }
  throw new Error(`Port ${port} did not become ready within ${timeoutMs}ms`);
}

async function waitForCdpPort(port: number, timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(`http://localhost:${port}/json/list`, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await sleep(500);
  }
  throw new Error(`CDP port ${port} did not become ready within ${timeoutMs}ms`);
}

async function getRendererWsUrl(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://localhost:${port}/json/list`, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const targets = JSON.parse(body) as Array<{
              type: string;
              url: string;
              webSocketDebuggerUrl: string;
            }>;
            const page = targets.find(
              (t) =>
                t.type === 'page' &&
                (t.url.includes(`localhost:${DEV_PORT}`) ||
                  t.url.includes('localhost:4002'))
            );
            if (!page) {
              reject(
                new Error(
                  `Renderer target not found. Available: ${targets
                    .map((t) => `${t.type}:${t.url}`)
                    .join(', ')}`
                )
              );
              return;
            }
            resolve(page.webSocketDebuggerUrl);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function cdpEval<T = unknown>(
  wsUrl: string,
  expression: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let enabled = false;

    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable', params: {} }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as {
        id?: number;
        result?: { result?: { value?: T; type?: string } };
        error?: { message: string };
      };

      if (msg.id === 1) {
        enabled = true;
        ws.send(
          JSON.stringify({
            id: 2,
            method: 'Runtime.evaluate',
            params: {
              expression,
              returnByValue: true,
              awaitPromise: true,
            },
          })
        );
        return;
      }

      if (msg.id === 2) {
        ws.close();
        if (msg.error) {
          reject(new Error(msg.error.message));
          return;
        }
        const result = msg.result?.result;
        if (result?.type === 'undefined') {
          resolve(undefined as T);
          return;
        }
        resolve(result?.value as T);
      }
    });

    ws.on('error', reject);
  });
}

async function cdpCommand(wsUrl: string, method: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method, params: {} }));
    });
    ws.on('message', () => {
      ws.close();
      resolve();
    });
    ws.on('error', reject);
  });
}

function buildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, NODE_ENV: 'development' };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function startDevServer(): ChildProcess {
  return crossSpawn('npm', ['run', 'dev:renderer'], {
    cwd: PROJECT_ROOT,
    shell: false,
    env: buildEnv(),
  });
}

function startElectron(cdpPort: number): ChildProcess {
  const proc = crossSpawn(
    'electron',
    [
      '.',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${USER_DATA_DIR}`,
    ],
    {
      cwd: PROJECT_ROOT,
      shell: false,
      env: buildEnv(),
    }
  );
  proc.stdout?.on('data', (d) =>
    console.log('[electron out]', d.toString().trim())
  );
  proc.stderr?.on('data', (d) =>
    console.log('[electron err]', d.toString().trim())
  );
  proc.on('exit', (code) => console.log('[electron exit]', code));
  return proc;
}

async function killProcess(proc: ChildProcess, label: string): Promise<void> {
  if (!proc || proc.killed) return;
  return new Promise((resolve) => {
    proc.on('exit', () => resolve());
    proc.on('error', () => resolve());
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']).on(
        'exit',
        () => resolve()
      );
    } else {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    }
  });
}

function buildMainDev(): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log('Building main process (dev mode)...');
    const proc = crossSpawn(
      'npm',
      ['run', 'build:main:dev'],
      {
        cwd: PROJECT_ROOT,
        shell: false,
        env: buildEnv(),
      }
    );
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`build:main:dev exited with ${code}`));
    });
    proc.on('error', reject);
  });
}

async function main(): Promise<void> {
  await buildMainDev();

  const devServer = startDevServer();
  let electron: ChildProcess | null = null;
  let electron2: ChildProcess | null = null;

  try {
    console.log('Waiting for dev server on port', DEV_PORT, '...');
    await waitForPort(DEV_PORT);
    console.log('Dev server ready.');

    console.log('Launching Electron (first run)...');
    const cdpPort1 = CDP_PORT;
    electron = startElectron(cdpPort1);

    // Wait for CDP and the renderer to load + rehydrate.
    await waitForCdpPort(cdpPort1);
    await sleep(3000);

    const wsUrl = await getRendererWsUrl(cdpPort1);
    console.log('Connected to renderer via CDP.');

    const initialTheme = await cdpEval<string | undefined>(
      wsUrl,
      'window.__WHALE_STORE__?.getState().settings.themeMode'
    );
    console.log('Initial themeMode:', initialTheme);

    console.log("Dispatching setThemeMode('dark')...");
    await cdpEval(
      wsUrl,
      "window.__WHALE_STORE__.dispatch({type:'settings/SET_THEME_MODE', payload:'dark'})"
    );

    const afterDispatch = await cdpEval<string | undefined>(
      wsUrl,
      'window.__WHALE_STORE__?.getState().settings.themeMode'
    );
    console.log('Theme immediately after dispatch:', afterDispatch);

    // Force redux-persist to flush so the next read sees the latest state.
    console.log('Flushing redux-persist...');
    await cdpEval(wsUrl, 'window.__WHALE_PERSISTOR__.flush()');

    const persistedRaw = await cdpEval<string | null>(
      wsUrl,
      "localStorage.getItem('persist:whale-root')"
    );
    console.log('Persisted raw before close:', persistedRaw?.slice(0, 400));

    // Parse settings portion for quick check.
    const persistedTheme = await cdpEval<string | undefined>(
      wsUrl,
      "(() => { const raw = localStorage.getItem('persist:whale-root'); if (!raw) return undefined; const parsed = JSON.parse(raw); const settingsStr = parsed.settings; if (!settingsStr) return undefined; return JSON.parse(settingsStr).themeMode; })()"
    );
    console.log('Persisted themeMode before close:', persistedTheme);

    // Control test: write a plain localStorage key directly and see if it
    // survives the same close/restart cycle.
    console.log('Writing control key to localStorage...');
    await cdpEval(wsUrl, "localStorage.setItem('__whale_control__', 'dark')");

    console.log('Asking main process to close window gracefully...');
    await cdpEval(wsUrl, 'window.whale.requestQuit()');

    // Wait for Electron to exit.
    await new Promise<void>((resolve) => {
      if (!electron) return resolve();
      electron.on('exit', () => resolve());
      setTimeout(() => resolve(), 10000); // fallback
    });
    console.log('Electron exited.');

    // Make sure no Electron child processes are still holding the user data
    // directory open before relaunching.
    await new Promise<void>((resolve) => {
      spawn('powershell', [
        '-Command',
        "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'electron.exe' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }",
      ]).on('exit', () => resolve());
    });

    // Give Chromium time to release locks and commit localStorage to LevelDB.
    await sleep(10000);
    const cdpPort2 = CDP_PORT + 1;
    electron2 = startElectron(cdpPort2);
    await waitForCdpPort(cdpPort2);
    await sleep(3000);

    const wsUrl2 = await getRendererWsUrl(cdpPort2);
    const storedTheme = await cdpEval<string | undefined>(
      wsUrl2,
      "(() => { const raw = localStorage.getItem('persist:whale-root'); if (!raw) return undefined; const parsed = JSON.parse(raw); const settingsStr = parsed.settings; if (!settingsStr) return undefined; return JSON.parse(settingsStr).themeMode; })()"
    );
    console.log('Stored themeMode on disk after restart:', storedTheme);

    const controlKey = await cdpEval<string | null>(
      wsUrl2,
      "localStorage.getItem('__whale_control__')"
    );
    console.log('Control key after restart:', controlKey);

    const themeAfterRestart = await cdpEval<string | undefined>(
      wsUrl2,
      'window.__WHALE_STORE__?.getState().settings.themeMode'
    );
    console.log('Theme after restart:', themeAfterRestart);

    if (themeAfterRestart === 'dark') {
      console.log('\n✅ PASS: settings persisted across restart');
      process.exitCode = 0;
    } else {
      console.log('\n❌ FAIL: expected dark, got', themeAfterRestart);
      process.exitCode = 1;
    }
  } catch (e) {
    console.error('\n❌ ERROR:', e);
    process.exitCode = 1;
  } finally {
    if (electron2) await killProcess(electron2, 'electron2');
    if (electron) await killProcess(electron, 'electron');
    await killProcess(devServer, 'dev server');
  }
}

main();
