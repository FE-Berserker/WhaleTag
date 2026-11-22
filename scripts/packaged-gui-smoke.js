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
    throw new Error('Packaged GUI smoke currently supports Windows artifacts only');
  }
  if (!fs.existsSync(executablePath)) {
    throw new Error(
      `Packaged executable not found: ${executablePath}\n` +
        'Build it with: npm run package:win -- --dir'
    );
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-packaged-gui-'));
  const fixtureRoot = path.join(tempRoot, 'fixture');
  const expectedClipboard = path.join(fixtureRoot, 'smoke.png');
  const editorPath = path.join(fixtureRoot, 'smoke.txt');
  const appData = path.join(tempRoot, 'appdata');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'local-appdata'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'tmp'), { recursive: true });
  fs.writeFileSync(
    expectedClipboard,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    )
  );
  fs.writeFileSync(editorPath, 'before GUI smoke\n', 'utf8');

  const env = {
    ...process.env,
    APPDATA: appData,
    LOCALAPPDATA: path.join(tempRoot, 'local-appdata'),
    TEMP: path.join(tempRoot, 'tmp'),
    TMP: path.join(tempRoot, 'tmp'),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  let electronApp;
  let originalClipboard;
  let clipboardTouched = false;
  let copyPathVerified = false;
  let clipboardSkipReason = '';
  try {
    electronApp = await electron.launch({
      executablePath,
      env,
      timeout: 30_000,
    });

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
    await withTimeout(
      page.getByText('Welcome to WhaleTag', { exact: true }).waitFor({ state: 'visible' }),
      20_000,
      'main renderer UI'
    );

    originalClipboard = await electronApp.evaluate(({ clipboard }) => ({
      text: clipboard.readText(),
      formats: clipboard.availableFormats().map((format) => ({
        format,
        data: clipboard.readBuffer(format).toString('base64'),
      })),
    }));
    // The OS clipboard is global, not isolated by APPDATA. Only an empty
    // clipboard or a single text/plain value has a reliable Electron restore
    // path. Formatted text, images, FileNameW, URI lists and other formats
    // stay untouched; clean CI runners still exercise the real clipboard write.
    const formats = originalClipboard.formats.map((item) => item.format);
    const canRestoreClipboard =
      (formats.length === 0 && !originalClipboard.text) ||
      (formats.length === 1 && formats[0] === 'text/plain');
    const sentinel = `whale-gui-smoke-before-${Date.now()}`;
    if (!canRestoreClipboard) {
      clipboardSkipReason =
        `existing clipboard left untouched: ${formats.join(', ') || 'unlisted text clipboard data'}`;
      console.warn(`Copy Path smoke skipped; ${clipboardSkipReason}`);
    } else {
      await electronApp.evaluate(
        ({ clipboard }, value) => clipboard.writeText(value),
        sentinel
      );
      clipboardTouched = true;
    }

    // Native dialogs are outside Playwright's DOM automation. Replace only the
    // main-process picker response in this disposable app, then exercise the
    // real Add Location UI, known-roots provenance, file row and context menu.
    await electronApp.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    }, fixtureRoot);
    await page.getByRole('button', { name: 'Add Location', exact: true }).last().click();
    await page.getByLabel('Location name', { exact: true }).fill('Packaged GUI smoke');
    await page.getByRole('button', { name: 'Browse', exact: true }).click();
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    const row = page.getByTitle('smoke.png', { exact: true });
    try {
      await withTimeout(row.waitFor({ state: 'visible' }), 30_000, 'fixture file row');
    } catch (error) {
      const bodyText = await page.locator('body').innerText();
      throw new Error(
        `${error instanceof Error ? error.message : error}\nRenderer text:\n${bodyText.slice(0, 4000)}`
      );
    }
    assert.equal(await row.count(), 1, 'Expected exactly one fixture file row');
    if (!clipboardSkipReason) {
      await row.click({ button: 'right' });
      const copyPath = page.getByRole('menuitem', { name: 'Copy Path', exact: true });
      await copyPath.waitFor({ state: 'visible' });
      await copyPath.click();
      const copiedText = await poll(
        () =>
          electronApp.evaluate(({ clipboard }, previous) => {
            const value = clipboard.readText();
            return value && value !== previous ? value : null;
          }, sentinel),
        5_000,
        'renderer clipboard write'
      );
      assert.equal(copiedText, expectedClipboard, 'Real Copy Path click must write the fixture path');
      copyPathVerified = true;
    }

    await row.click({ button: 'right' });
    const imageViewer = page.getByRole('menuitem', { name: 'Image Viewer', exact: true });
    await imageViewer.waitFor({ state: 'visible' });
    await imageViewer.click();
    const viewer = page.frameLocator('iframe[title="Image Viewer"]');
    const image = viewer.locator('#image');
    await withTimeout(image.waitFor({ state: 'visible' }), 20_000, 'image viewer load');
    const loadedWidth = await poll(
      () => image.evaluate((element) => element.naturalWidth),
      10_000,
      'image decode'
    );
    assert.equal(loadedWidth, 1);
    assert.equal(
      await image.evaluate(() => document.fullscreenEnabled),
      true,
      'Image viewer iframe must allow fullscreen'
    );
    const fullscreen = viewer.locator('#fullscreen');
    await fullscreen.click();
    await poll(
      () => image.evaluate(() => Boolean(document.fullscreenElement)),
      5_000,
      'image viewer enter fullscreen'
    );
    await fullscreen.click();
    await poll(
      () => image.evaluate(() => !document.fullscreenElement),
      5_000,
      'image viewer exit fullscreen'
    );

    // MUI marks the background aria-hidden while the discard dialog is open;
    // role locators would then lose the very tab whose focus we need to assert.
    const viewerTab = page.locator('[role="tab"]').filter({ hasText: 'smoke.png' });

    const textRow = page.getByTitle('smoke.txt', { exact: true });
    await textRow.waitFor({ state: 'attached' });
    // FileList remains mounted beneath the extension overlay. Open the second
    // tab through its real context-menu handler without closing the image tab;
    // the visible menu item below is still clicked like a normal user action.
    await textRow.dispatchEvent('contextmenu', {
      button: 2,
      clientX: 320,
      clientY: 240,
    });
    const textEditorItem = page.getByRole('menuitem', { name: 'Text Editor', exact: true });
    await textEditorItem.waitFor({ state: 'visible' });
    await textEditorItem.click();
    const textTab = page.locator('[role="tab"]').filter({ hasText: 'smoke.txt' });
    const editorFrame = page.frameLocator('iframe[title="Text Editor"]');
    const editor = editorFrame.locator('.cm-content');
    await withTimeout(editor.waitFor({ state: 'visible' }), 20_000, 'text editor load');
    await poll(
      async () => (await editor.textContent())?.includes('before GUI smoke'),
      10_000,
      'text editor content'
    );
    await editor.click();
    await editor.fill('after GUI smoke\n');
    await editor.press('Control+s');
    const savedText = await poll(
      () => {
        const value = fs.readFileSync(editorPath, 'utf8');
        return value === 'before GUI smoke\n' ? null : value;
      },
      5_000,
      'text editor disk save'
    );
    assert.equal(savedText, 'after GUI smoke\n', 'Real editor Ctrl+S must persist the edit');

    // A dirty background tab is temporarily focused while its close prompt is
    // visible. Cancelling must restore the previously active tab and keep the
    // dirty tab open; this guards the real React/provider flow, not a fixture.
    await editor.fill('after cancelled close GUI smoke\n');
    await poll(
      async () => (await textTab.innerText()).includes('•'),
      5_000,
      'text tab dirty before cancelled close'
    );
    await viewerTab.click();
    await poll(
      async () => (await viewerTab.getAttribute('aria-selected')) === 'true',
      5_000,
      'image tab activation'
    );
    await textTab.getByRole('button', { name: 'Close', exact: true }).click();
    const cancelClose = page.getByRole('button', { name: 'Cancel', exact: true });
    await cancelClose.waitFor({ state: 'visible' });
    if ((await textTab.count()) !== 1) {
      const bodyText = await page.locator('body').innerText();
      throw new Error(
        `Dirty text tab disappeared while its close dialog was open.\n${bodyText.slice(0, 3000)}`
      );
    }
    assert.equal(
      await textTab.getAttribute('aria-selected'),
      'true',
      'Close confirmation must focus the dirty tab before cancellation'
    );
    await cancelClose.click();
    await poll(
      async () => (await viewerTab.getAttribute('aria-selected')) === 'true',
      5_000,
      'active tab restoration after cancelled close'
    );
    assert.equal(await textTab.count(), 1, 'Cancelled close must keep the dirty tab open');
    assert.equal(await textTab.getAttribute('aria-selected'), 'false');

    await textTab.click();
    await editor.click();
    await editor.press('Control+s');
    const savedAfterCancel = await poll(
      () => {
        const value = fs.readFileSync(editorPath, 'utf8');
        return value === 'after cancelled close GUI smoke\n' ? value : null;
      },
      5_000,
      'text editor save after cancelled close'
    );
    assert.equal(savedAfterCancel, 'after cancelled close GUI smoke\n');
    await poll(
      async () => !(await textTab.innerText()).includes('•'),
      5_000,
      'text editor clean state'
    );
    await textTab.getByRole('button', { name: 'Close', exact: true }).click();
    await viewerTab.getByRole('button', { name: 'Close', exact: true }).click();

    const clipboardResult = copyPathVerified
      ? 'Copy Path clipboard'
      : `Copy Path skipped (${clipboardSkipReason})`;
    console.log(
      `Packaged GUI smoke completed: Add Location + ${clipboardResult} + ` +
        'Image Viewer fullscreen + Text Editor save + cancelled dirty close.'
    );
  } finally {
    if (electronApp) {
      if (clipboardTouched) {
        try {
          await electronApp.evaluate(async ({ clipboard }, snapshot) => {
            const byFormat = Object.fromEntries(
              snapshot.formats.map((item) => [item.format, item.data])
            );
            const restored = {};
            if (byFormat['text/plain']) {
              restored.text = Buffer.from(byFormat['text/plain'], 'base64').toString('utf8');
            }
            if (byFormat['text/html']) {
              restored.html = Buffer.from(byFormat['text/html'], 'base64').toString('utf8');
            }
            if (byFormat['text/rtf']) {
              restored.rtf = Buffer.from(byFormat['text/rtf'], 'base64').toString('utf8');
            }
            clipboard.clear();
            if (snapshot.formats.length > 0) clipboard.write(restored);

            const expectedFormats = snapshot.formats.map((item) => item.format).sort();
            const verifyRestoration = () => {
              const actualFormats = clipboard.availableFormats().sort();
              if (JSON.stringify(actualFormats) !== JSON.stringify(expectedFormats)) {
                return (
                  `format mismatch: expected ${expectedFormats.join(', ') || '(empty)'}, ` +
                  `got ${actualFormats.join(', ') || '(empty)'}`
                );
              }
              if (clipboard.readText() !== snapshot.text) {
                return 'text read-back did not match the snapshot';
              }
              for (const item of snapshot.formats) {
                if (!item.format.startsWith('text/')) continue;
                const actual = clipboard.readBuffer(item.format).toString('base64');
                if (actual !== item.data) return `read-back mismatch for ${item.format}`;
              }
              return null;
            };
            // Windows clipboard ownership changes can be visible a little after
            // clipboard.write returns. Keep the strict byte/format assertions,
            // but allow the OS clipboard to settle before declaring failure.
            let lastError = 'clipboard read-back was not attempted';
            for (let attempt = 0; attempt < 50; attempt += 1) {
              lastError = verifyRestoration();
              if (lastError === null) return;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            throw new Error(`Clipboard restoration did not stabilize: ${lastError}`);
          }, originalClipboard);
        } catch (error) {
          console.error('Could not restore the previous clipboard formats:', error);
          process.exitCode = 1;
        }
      }
      try {
        await withTimeout(electronApp.close(), 10_000, 'Electron GUI shutdown');
      } catch (error) {
        electronApp.process().kill();
        console.error('Electron GUI shutdown failed; killed the process:', error);
        process.exitCode = 1;
      }
    }
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (error) {
      // Never hide the original smoke assertion behind a Windows cleanup error.
      console.warn('Could not remove temporary GUI smoke data:', error);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
