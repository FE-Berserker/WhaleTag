#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..');
const executablePath = path.resolve(
  process.argv[2] || path.join(ROOT, 'release', 'build', 'win-unpacked', 'WhaleTag.exe')
);
const BEFORE = 'before-drawio-smoke';
const AFTER = 'after-drawio-smoke';
const INITIAL_XML = `<mxfile host="app.diagrams.net"><diagram id="smoke" name="Page-1"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="${BEFORE}" style="text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="240" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`;

function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
        milliseconds
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function poll(read, milliseconds, label) {
  const deadline = Date.now() + milliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `${label} timed out after ${milliseconds}ms${lastError ? `: ${lastError}` : ''}`
  );
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('Packaged drawio smoke currently supports Windows artifacts only');
  }
  if (!fs.existsSync(executablePath)) {
    throw new Error(
      `Packaged executable not found: ${executablePath}\n` +
        'Build it with: npm run package:win -- --dir'
    );
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-packaged-drawio-'));
  const fixtureRoot = path.join(tempRoot, 'fixture');
  const drawioPath = path.join(fixtureRoot, 'smoke.drawio');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'local-appdata'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'tmp'), { recursive: true });
  fs.writeFileSync(drawioPath, INITIAL_XML, 'utf8');

  const env = {
    ...process.env,
    APPDATA: path.join(tempRoot, 'appdata'),
    LOCALAPPDATA: path.join(tempRoot, 'local-appdata'),
    TEMP: path.join(tempRoot, 'tmp'),
    TMP: path.join(tempRoot, 'tmp'),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  let electronApp;
  let stage = 'launch';
  const watchdog = setTimeout(() => {
    process.exitCode = 1;
    console.error(`Packaged drawio smoke exceeded 300000ms during ${stage}; killing Electron`);
    if (electronApp) electronApp.process().kill();
  }, 300_000);
  try {
    electronApp = await electron.launch({ executablePath, env, timeout: 30_000 });
    stage = 'window';
    const page = await withTimeout(
      electronApp.firstWindow(),
      20_000,
      'first renderer window'
    );
    await withTimeout(
      page.waitForLoadState('domcontentloaded'),
      20_000,
      'renderer DOM load'
    );
    assert.ok(page.url().includes('app.asar'), `Expected packaged renderer URL, got ${page.url()}`);

    stage = 'editor';
    // Only the native picker result is replaced. Location creation, file
    // opening and editor messages use the real production UI.
    await electronApp.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    }, fixtureRoot);
    await page.getByRole('button', { name: 'Add Location', exact: true }).last().click();
    await page.getByLabel('Location name', { exact: true }).fill('Packaged drawio smoke');
    await page.getByRole('button', { name: 'Browse', exact: true }).click();
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    const row = page.getByTitle('smoke.drawio', { exact: true });
    await withTimeout(row.waitFor({ state: 'visible' }), 30_000, 'drawio fixture row');
    await row.click({ button: 'right' });
    const openWithDrawio = page.getByRole('menuitem', { name: 'Draw.io', exact: true });
    await openWithDrawio.waitFor({ state: 'visible' });
    await openWithDrawio.click();

    const extension = page.frameLocator('iframe[title="Draw.io"]');
    const editor = extension.frameLocator('iframe.drawio-iframe');
    await withTimeout(
      editor.locator('.geDiagramContainer').waitFor({ state: 'visible' }),
      30_000,
      'drawio webapp init'
    );
    // The copied index must pin every lazy viewer path to this inner origin.
    // Preload without executing: custom-protocol renderer fetch is unavailable,
    // while a successful subresource load proves the configured file is served.
    stage = 'offline';
    const offlineUrls = await withTimeout(
      editor.locator('html').evaluate(() => {
        const viewer = window.DRAWIO_VIEWER_URL;
        const base = window.DRAWIO_BASE_URL;
        const lightbox = window.DRAWIO_LIGHTBOX_URL;
        if (
          [viewer, base, lightbox].some(
            (value) => typeof value !== 'string' || value.length === 0
          ) ||
          window.VIEWER_URL !== viewer
        ) {
          throw new Error(
            'Draw.io offline URLs are not configured: ' +
              `viewer=${String(viewer)}, base=${String(base)}, lightbox=${String(lightbox)}, ` +
              `VIEWER_URL=${String(window.VIEWER_URL)}, href=${window.location.href}`
          );
        }
        const viewerUrl = new URL(viewer, window.location.href);
        const baseUrl = new URL(base, window.location.href);
        const lightboxUrl = new URL(lightbox, window.location.href);
        if (
          viewerUrl.origin !== window.location.origin ||
          baseUrl.origin !== window.location.origin ||
          lightboxUrl.origin !== window.location.origin ||
          !viewerUrl.pathname.endsWith('/js/viewer-static.min.js') ||
          baseUrl.pathname !== '/drawio-assets' ||
          lightboxUrl.pathname !== '/drawio-assets'
        ) {
          throw new Error(
            `Unexpected Draw.io offline URLs: viewer=${viewerUrl.href}, ` +
              `base=${baseUrl.href}, lightbox=${lightboxUrl.href}`
          );
        }
        return new Promise((resolve, reject) => {
          const link = document.createElement('link');
          const timer = setTimeout(() => {
            link.remove();
            reject(new Error('Timed out loading the offline viewer-static bundle'));
          }, 15000);
          link.rel = 'preload';
          link.as = 'script';
          link.href = viewerUrl.href;
          link.onload = () => {
            clearTimeout(timer);
            link.remove();
            resolve({ baseUrl: baseUrl.href, lightboxUrl: lightboxUrl.href });
          };
          link.onerror = () => {
            clearTimeout(timer);
            link.remove();
            reject(new Error('Could not load the offline viewer-static bundle'));
          };
          document.head.append(link);
        });
      }),
      20_000,
      'drawio offline viewer-static.min.js resource'
    );
    // Prove the local Link/Lightbox document is served through the scoped
    // directory mapping. drawio-offline does not ship embed-static.min.js or
    // embed.js, so this smoke deliberately does not claim HTML-embed support.
    stage = 'lightbox';
    const offlineLightbox = await withTimeout(
      electronApp.evaluate(async ({ net }, lightboxUrl) => {
        const url = `${lightboxUrl}/?client=1`;
        const response = await net.fetch(url);
        const body = await response.text();
        return { url, status: response.status, body };
      }, offlineUrls.lightboxUrl),
      20_000,
      'drawio offline Lightbox document'
    );
    if (
      offlineLightbox.status !== 200 ||
      !offlineLightbox.body.includes('js/app.min.js')
    ) {
      throw new Error(
        `Draw.io offline Lightbox document failed: ${offlineLightbox.status} ${offlineLightbox.url}`
      );
    }
    stage = 'render';
    await withTimeout(
      editor.getByText(BEFORE, { exact: true }).waitFor({ state: 'visible' }),
      15_000,
      'drawio fixture render'
    );

    stage = 'edit';
    // Edit the actual graph label through drawio's own cell editor.
    await editor.getByText(BEFORE, { exact: true }).dblclick();
    const cellEditor = editor.locator('.mxCellEditor');
    await withTimeout(cellEditor.waitFor({ state: 'visible' }), 5_000, 'drawio cell editor');
    await cellEditor.fill(AFTER);
    await cellEditor.press('Escape');
    await poll(
      async () => (await editor.locator('body').innerText()).includes(AFTER),
      5_000,
      'drawio edited label'
    );

    stage = 'save';
    // Scope the real Save control to this extension's host toolbar. Production
    // MUI icons omit data-testid, so also recognize the standard Save path.
    const hostContent = page.locator('iframe[title="Draw.io"]').locator('xpath=..');
    const hostToolbar = hostContent.locator('xpath=preceding-sibling::*[1]');
    const saveButton = hostToolbar
      .locator(
        'button:has(svg[data-testid="SaveIcon"]), ' +
          'button:has(svg path[d^="M17 3H5c-1.11"])'
      )
      .first();
    try {
      await withTimeout(saveButton.waitFor({ state: 'visible' }), 10_000, 'drawio host Save');
    } catch (error) {
      const toolbarHtml = await hostToolbar.evaluate((toolbar) => toolbar.outerHTML);
      console.error('Active Draw.io host toolbar when Save was not found:', toolbarHtml);
      throw error;
    }
    assert.equal(await saveButton.isEnabled(), true, 'Host Save button must be enabled');
    const beforeSaveXml = fs.readFileSync(drawioPath, 'utf8');
    const beforeSaveStat = fs.statSync(drawioPath);
    await saveButton.click();
    stage = 'readback';
    const saved = await poll(
      async () => {
        const xml = fs.readFileSync(drawioPath, 'utf8');
        return xml.includes(AFTER) && !xml.includes(BEFORE)
          ? { xml, stat: fs.statSync(drawioPath) }
          : null;
      },
      15_000,
      'drawio disk Save readback'
    );
    assert.notEqual(saved.xml, beforeSaveXml, 'Save must change the on-disk XML');
    assert.ok(
      saved.stat.mtimeMs > beforeSaveStat.mtimeMs,
      'Saved file mtime must increase'
    );
    assert.ok(saved.xml.includes(AFTER), 'Disk readback must contain the edited label');
    stage = 'success';

    console.log(
      'Packaged drawio smoke passed: real Add Location + offline viewer bundle + Lightbox document + ' +
        'webapp init/render + label edit + host Save + disk AFTER readback.'
    );
  } finally {
    stage = 'cleanup';
    if (electronApp) {
      try {
        await withTimeout(electronApp.close(), 10_000, 'Electron drawio shutdown');
      } catch (error) {
        electronApp.process().kill();
        console.error('Electron drawio shutdown failed; killed the process:', error);
        process.exitCode = 1;
      }
    }
    clearTimeout(watchdog);
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (error) {
      // Never hide the original smoke assertion behind a Windows cleanup error.
      console.warn('Could not remove temporary Draw.io smoke data:', error);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
