#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..');
const useCurrentBuild = process.env.WHALETAG_GUI_USE_CURRENT_BUILD === '1';
const executablePath = path.resolve(
  process.argv[2] ||
    (useCurrentBuild
      ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
      : path.join(ROOT, 'release', 'build', 'win-unpacked', 'WhaleTag.exe'))
);
const currentMainPath = path.join(ROOT, 'release', 'app', 'dist', 'main', 'main.js');
const BEFORE = 'before-excalidraw-smoke';
const AFTER = 'after-excalidraw-smoke';

function errorText(error) {
  return String((error && error.stack) || error);
}

// Every Excalidraw font is registered as a FontFace whose source list is the
// bundled whale-extension URL followed by the upstream esm.sh URL. The bundled
// fonts load from the extension scheme (canvas text renders with them), but the
// browser evaluates the policy for the upstream URL of every font file at
// registration and reports one CSP violation per file, whether or not that font
// is used. Keep that documented noise separate from real async-chunk errors.
const EXCALIDRAW_FONT_URL =
  /^https:\/\/esm\.sh\/@excalidraw\/excalidraw@0\.18\.1\/dist\/prod\/fonts\/[^/'?#]+\/[^/'?#]+\.woff2$/;
const EXCALIDRAW_SOURCE_URL =
  /^whale-extension:\/\/excalidraw-editor\/(?:bundle\.js|chunks\/[^/'?#]+\.js)$/;
// Chromium quotes the extension CSP's `font-src` source list verbatim, so match
// the shape of the message instead of one exact source list: adding a source
// to the policy must not turn this documented fallback into a smoke failure.
const EXCALIDRAW_FONT_CONSOLE_PATTERN =
  /^Loading the font '(https:\/\/esm\.sh\/@excalidraw\/excalidraw@0\.18\.1\/dist\/prod\/fonts\/[^/'?#]+\/[^/'?#]+\.woff2)' violates the following Content Security Policy directive: "font-src [^"]*\bwhale-extension:\/\/\*[^"]*"\. The action has been blocked\.$/;

function isKnownExcalidrawFontConsole(message) {
  return (
    message.type === 'error' &&
    EXCALIDRAW_SOURCE_URL.test(message.location?.url || '') &&
    EXCALIDRAW_FONT_CONSOLE_PATTERN.test(message.text)
  );
}

function isKnownExcalidrawFontRequest(request) {
  return (
    request.resourceType === 'font' &&
    request.method === 'GET' &&
    (request.errorText === 'csp' || request.errorText === 'net::ERR_BLOCKED_BY_CSP') &&
    EXCALIDRAW_FONT_URL.test(request.url)
  );
}

const INITIAL_SCENE = JSON.stringify({
  type: 'excalidraw',
  version: 2,
  source: 'whale',
  elements: [
    {
      id: 'smoke-rectangle',
      type: 'rectangle',
      x: 80,
      y: 80,
      width: 360,
      height: 140,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: '#ffffff',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: { type: 3 },
      seed: 101,
      version: 1,
      versionNonce: 102,
      isDeleted: false,
      boundElements: [{ type: 'text', id: 'smoke-text' }],
      updated: 1,
      link: null,
      locked: false,
    },
    {
      id: 'smoke-text',
      type: 'text',
      x: 110,
      y: 137.5,
      width: 300,
      height: 25,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 201,
      version: 1,
      versionNonce: 202,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      text: BEFORE,
      fontSize: 20,
      fontFamily: 1,
      textAlign: 'center',
      verticalAlign: 'middle',
      containerId: 'smoke-rectangle',
      originalText: BEFORE,
      autoResize: true,
      lineHeight: 1.25,
    },
  ],
  appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
  files: {},
});

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

class FatalSmokeError extends Error {}

async function poll(read, milliseconds, label) {
  const deadline = Date.now() + milliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      if (error instanceof FatalSmokeError) throw error;
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `${label} timed out after ${milliseconds}ms${lastError ? `: ${lastError}` : ''}`
  );
}

async function readCanvasRender(locator, onProbe) {
  const probe = await locator.evaluateAll((canvases) => {
    let ink = 0;
    let width = 0;
    let height = 0;
    const details = [];
    for (const canvas of canvases) {
      if (!(canvas instanceof HTMLCanvasElement)) continue;
      const rect = canvas.getBoundingClientRect();
      const detail = {
        className: canvas.className,
        width: canvas.width,
        height: canvas.height,
        cssWidth: rect.width,
        cssHeight: rect.height,
        ink: 0,
        contextError: null,
      };
      details.push(detail);
      if (canvas.width === 0 || canvas.height === 0) continue;
      try {
        const context = canvas.getContext('2d');
        if (!context) {
          detail.contextError = 'No 2D context';
          continue;
        }
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let index = 0; index < pixels.length; index += 4) {
          if (
            pixels[index + 3] > 0 &&
            (pixels[index] < 240 || pixels[index + 1] < 240 || pixels[index + 2] < 240)
          ) {
            detail.ink += 1;
          }
        }
      } catch (error) {
        detail.contextError = String(error);
      }
      if (detail.ink > 20) {
        ink += detail.ink;
        width = Math.max(width, canvas.width);
        height = Math.max(height, canvas.height);
      }
    }
    return {
      ink,
      width,
      height,
      canvases: details,
      fontStatus: document.fonts.status,
      fontFaceCount: document.fonts.size,
      bodyText: document.body.innerText.slice(0, 1200),
    };
  });
  if (onProbe) onProbe(probe);
  return probe.ink > 20 ? probe : null;
}

async function readHostFileContentMessages(page) {
  const editorFrame = page
    .frames()
    .find((frame) => frame.url().startsWith('whale-extension://excalidraw-editor/'));
  if (!editorFrame) return [];
  const messages = await editorFrame.evaluate(
    () => window.__packagedExcalidrawSmokeMessages || []
  );
  return messages.map((message) => {
    const result = { ...message, parsed: null, parseError: null };
    try {
      const data = JSON.parse(message.content || '{}');
      result.parsed = {
        type: data.type,
        version: data.version,
        elementCount: Array.isArray(data.elements) ? data.elements.length : null,
        elements: Array.isArray(data.elements)
          ? data.elements.map((element) => ({
              id: element.id,
              type: element.type,
              x: element.x,
              y: element.y,
              width: element.width,
              height: element.height,
              isDeleted: element.isDeleted,
              containerId: element.containerId,
              boundElements: element.boundElements,
            }))
          : null,
        appState: data.appState,
      };
    } catch (error) {
      result.parseError = String(error);
    }
    return result;
  });
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('Packaged Excalidraw smoke currently supports Windows artifacts only');
  }
  if (!fs.existsSync(executablePath)) {
    throw new Error(
      `Packaged executable not found: ${executablePath}\n` +
        'Build it with: npm run package:win -- --dir'
    );
  }

  fs.mkdirSync(path.join(ROOT, 'artifacts'), { recursive: true });
  const outputDirectory = fs.mkdtempSync(
    path.join(ROOT, 'artifacts', 'packaged-excalidraw-smoke-')
  );
  const diagnosticsPath = path.join(outputDirectory, 'diagnostics.json');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-packaged-excalidraw-'));
  const fixtureRoot = path.join(tempRoot, 'fixture');
  const drawingPath = path.join(fixtureRoot, 'smoke.excalidraw');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'local-appdata'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'tmp'), { recursive: true });
  fs.writeFileSync(drawingPath, INITIAL_SCENE, 'utf8');

  const env = {
    ...process.env,
    APPDATA: path.join(tempRoot, 'appdata'),
    LOCALAPPDATA: path.join(tempRoot, 'local-appdata'),
    TEMP: path.join(tempRoot, 'tmp'),
    TMP: path.join(tempRoot, 'tmp'),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  let electronApp;
  let page;
  let stage = 'launch';
  const diagnostics = {
    name: 'packaged-excalidraw-smoke',
    startedAt: new Date().toISOString(),
    executablePath,
    launchMode: useCurrentBuild ? 'current-build' : 'packaged',
    outputDirectory,
    stage,
    ok: false,
    console: [],
    pageErrors: [],
    requestFailed: [],
    notFoundResponses: [],
    cleanupErrors: [],
  };
  const saveDiagnostics = () => {
    diagnostics.stage = stage;
    const knownConsole = diagnostics.console.filter(isKnownExcalidrawFontConsole);
    const knownRequests = diagnostics.requestFailed.filter(isKnownExcalidrawFontRequest);
    const unexpectedConsole = diagnostics.console.filter(
      (message) => message.type === 'error' && !isKnownExcalidrawFontConsole(message)
    );
    const unexpectedRequests = diagnostics.requestFailed.filter(
      (request) => !isKnownExcalidrawFontRequest(request)
    );
    diagnostics.knownFontFallbacks = {
      console: knownConsole.length,
      requestFailed: knownRequests.length,
      total: knownConsole.length + knownRequests.length,
    };
    diagnostics.unexpectedFailures = {
      console: unexpectedConsole.length,
      pageErrors: diagnostics.pageErrors.length,
      requestFailed: unexpectedRequests.length,
      notFoundResponses: diagnostics.notFoundResponses.length,
      total:
        unexpectedConsole.length +
        diagnostics.pageErrors.length +
        unexpectedRequests.length +
        diagnostics.notFoundResponses.length,
    };
    fs.writeFileSync(diagnosticsPath, JSON.stringify(diagnostics, null, 2) + '\n', 'utf8');
  };
  saveDiagnostics();

  const watchdog = setTimeout(() => {
    process.exitCode = 1;
    const message = `Packaged Excalidraw smoke exceeded 300000ms during ${stage}; killing Electron`;
    diagnostics.ok = false;
    diagnostics.failure = { stage, error: message };
    saveDiagnostics();
    console.error(message);
    if (electronApp) electronApp.process().kill();
  }, 300_000);
  try {
    electronApp = await electron.launch({
      executablePath,
      ...(useCurrentBuild ? { args: [currentMainPath] } : {}),
      env,
      timeout: 30_000,
    });
    stage = 'window';
    page = await withTimeout(
      electronApp.firstWindow(),
      20_000,
      'first renderer window'
    );
    // Page-level events include the production extension's nested iframes. Keep
    // diagnostics from launch through both lazy Mermaid loads and disk saves.
    page.on('console', (message) => {
      diagnostics.console.push({
        type: message.type(),
        text: message.text(),
        location: message.location(),
      });
      saveDiagnostics();
    });
    page.on('pageerror', (error) => {
      diagnostics.pageErrors.push(errorText(error));
      saveDiagnostics();
    });
    page.on('requestfailed', (request) => {
      diagnostics.requestFailed.push({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        errorText: request.failure()?.errorText || 'unknown request failure',
      });
      saveDiagnostics();
    });
    page.on('response', (response) => {
      if (response.status() === 404) {
        diagnostics.notFoundResponses.push({ url: response.url(), status: 404 });
        saveDiagnostics();
      }
    });
    // Record the real host-to-extension document envelopes in future extension
    // frames. This is read-only diagnostics for distinguishing a missing
    // fileContent handoff from an Excalidraw scene/render failure.
    await page.addInitScript(() => {
      window.addEventListener('message', (event) => {
        const envelope = event.data;
        if (envelope?.source !== 'host' || envelope?.message?.type !== 'fileContent') return;
        const message = envelope.message;
        window.__packagedExcalidrawSmokeMessages ||= [];
        window.__packagedExcalidrawSmokeMessages.push({
          path: message.path,
          content: message.content,
          encoding: message.encoding,
          readOnly: message.readOnly,
          size: message.size,
        });
      });
    });
    await withTimeout(
      page.waitForLoadState('domcontentloaded'),
      20_000,
      'renderer DOM load'
    );
    const normalizedUrl = page.url().replace(/\\/g, '/');
    assert.ok(
      normalizedUrl.includes(
        useCurrentBuild ? 'release/app/dist/renderer/index.html' : 'app.asar'
      ),
      `Expected ${useCurrentBuild ? 'current-build' : 'packaged'} renderer URL, got ${page.url()}`
    );

    stage = 'editor';
    // Only the native picker result is replaced. All subsequent actions use the
    // real production renderer and extension UI.
    await electronApp.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    }, fixtureRoot);
    await page.getByRole('button', { name: 'Add Location', exact: true }).last().click();
    await page.getByLabel('Location name', { exact: true }).fill('Packaged Excalidraw smoke');
    await page.getByRole('button', { name: 'Browse', exact: true }).click();
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    const row = page.getByTitle('smoke.excalidraw', { exact: true });
    await withTimeout(row.waitFor({ state: 'visible' }), 30_000, 'Excalidraw fixture row');
    await row.click({ button: 'right' });
    const openWithExcalidraw = page.getByRole('menuitem', { name: 'Excalidraw', exact: true });
    await openWithExcalidraw.waitFor({ state: 'visible' });
    await openWithExcalidraw.click();

    const editor = page.frameLocator('iframe[title="Excalidraw"]');
    const interactiveCanvas = editor.locator('canvas.excalidraw__canvas.interactive');
    await withTimeout(
      interactiveCanvas.waitFor({ state: 'visible' }),
      30_000,
      'Excalidraw canvas init'
    );
    stage = 'render';
    // Scene content is canvas-rendered, not DOM text. Read actual canvas pixels
    // and require non-white ink so an empty scene cannot pass as a loaded fixture.
    const rendered = await poll(
      () =>
        readCanvasRender(editor.locator('canvas.excalidraw__canvas'), (probe) => {
          diagnostics.canvasProbe = probe;
        }),
      20_000,
      'Excalidraw fixture canvas render'
    );
    diagnostics.hostFileContentMessages = await readHostFileContentMessages(page);
    assert.ok(rendered.ink > 20, 'Fixture must produce visible canvas ink');

    stage = 'edit';
    // The fixture uses zero scene scroll, so the rectangle center is a stable
    // real-canvas target. Double-click enters Excalidraw's bound-text editor.
    await interactiveCanvas.dblclick({ position: { x: 260, y: 150 } });
    const textEditor = editor.locator('textarea.excalidraw-wysiwyg');
    await withTimeout(textEditor.waitFor({ state: 'visible' }), 5_000, 'Excalidraw text editor');
    assert.equal(await textEditor.inputValue(), BEFORE, 'Must edit the fixture bound text');
    await textEditor.fill(AFTER);
    await textEditor.press('Escape');
    await textEditor.waitFor({ state: 'hidden' });

    stage = 'save';
    // Scope Save to this extension's own host toolbar. Production MUI icons do
    // not consistently expose data-testid, so recognize the standard path too.
    const hostContent = page.locator('iframe[title="Excalidraw"]').locator('xpath=..');
    const hostToolbar = hostContent.locator('xpath=preceding-sibling::*[1]');
    const saveButton = hostToolbar
      .locator(
        'button:has(svg[data-testid="SaveIcon"]), ' +
          'button:has(svg path[d^="M17 3H5c-1.11"])'
      )
      .first();
    const editorTab = page.locator('[role="tab"]').filter({ hasText: 'smoke.excalidraw' });
    const waitForHostDirty = (label) =>
      poll(
        async () => ((await editorTab.innerText()).includes('•') ? true : null),
        10_000,
        label
      );
    await withTimeout(saveButton.waitFor({ state: 'visible' }), 10_000, 'Excalidraw host Save');
    await waitForHostDirty('host dirty after bound-text edit');
    assert.equal(await saveButton.isEnabled(), true, 'Host Save button must be enabled after edit');
    const beforeSaveText = fs.readFileSync(drawingPath, 'utf8');
    const beforeSaveStat = fs.statSync(drawingPath);
    await saveButton.click();
    stage = 'readback';
    const saved = await poll(
      () => {
        const content = fs.readFileSync(drawingPath, 'utf8');
        const json = JSON.parse(content);
        const text = json.elements?.find((element) => element.id === 'smoke-text');
        return text?.originalText === AFTER && text.version > 1
          ? { content, json, stat: fs.statSync(drawingPath) }
          : null;
      },
      15_000,
      'Excalidraw disk Save readback'
    );
    assert.notEqual(saved.content, beforeSaveText, 'Save must change the on-disk JSON');
    assert.ok(saved.stat.mtimeMs > beforeSaveStat.mtimeMs, 'Saved file mtime must increase');
    assert.equal(saved.json.type, 'excalidraw');
    assert.equal(saved.json.version, 2);
    assert.ok(saved.json.elements.some((element) => element.id === 'smoke-rectangle'));
    const savedText = saved.json.elements.find((element) => element.id === 'smoke-text');
    assert.equal(savedText.text, AFTER);
    assert.equal(savedText.originalText, AFTER);
    assert.ok(savedText.version > 1, 'Editing must advance the fixture element version');
    await poll(
      async () => ((await editorTab.innerText()).includes('•') ? null : true),
      5_000,
      'host clean after bound-text Save'
    );

    stage = 'mermaid';
    const mermaidDefinition = 'flowchart TD\n  A-->B';
    // Seed only this disposable iframe origin's editor storage with the exact
    // minimal graph under test. Excalidraw otherwise starts converting a
    // complex default example on dialog mount, which can race the test input.
    // Here every initial or later preview is for the same A-->B definition.
    await editor.locator('body').evaluate((body, definition) => {
      const frameWindow = body.ownerDocument.defaultView;
      if (!frameWindow) throw new Error('Excalidraw frame window is unavailable');
      frameWindow.localStorage.setItem('mermaid-to-excalidraw', JSON.stringify(definition));
    }, mermaidDefinition);
    await editor.locator('.App-toolbar__extra-tools-trigger').click();
    const mermaidMenuItem = editor
      .locator('.App-toolbar__extra-tools-dropdown')
      .getByRole('button', { name: 'Mermaid to Excalidraw', exact: true });
    await withTimeout(mermaidMenuItem.waitFor({ state: 'visible' }), 10_000, 'Mermaid menu item');
    await mermaidMenuItem.click();
    const diagramDialog = editor.locator('.ttd-dialog');
    await diagramDialog.waitFor({ state: 'visible' });
    const previewCanvas = diagramDialog.locator(
      '.ttd-dialog-output-canvas-container canvas'
    );
    const mermaidInput = diagramDialog.locator(
      'textarea[placeholder="Write Mermaid diagram defintion here..."]'
    );
    await mermaidInput.waitFor({ state: 'visible' });
    assert.equal(
      await mermaidInput.inputValue(),
      mermaidDefinition,
      'Mermaid dialog must start from the seeded minimal definition, not the default example'
    );
    await mermaidInput.fill(mermaidDefinition);
    const generatedPreview = await poll(
      async () => {
        if ((await diagramDialog.count()) === 0) {
          const extensionBody = await editor
            .locator('body')
            .innerText()
            .catch(() => '<unavailable>');
          throw new FatalSmokeError(
            `Mermaid dialog closed before lazy-loaded preview; host tab: ${await editorTab.innerText()}; extension body: ${extensionBody.slice(0, 1200)}`
          );
        }
        return readCanvasRender(previewCanvas);
      },
      60_000,
      'Mermaid lazy-loaded graph TD preview'
    );
    assert.ok(generatedPreview.ink > 20, 'Mermaid preview must contain rendered graph ink');
    assert.equal(await mermaidInput.inputValue(), mermaidDefinition);
    assert.equal(
      await diagramDialog.locator('[data-testid="ttd-dialog-output-error"]').count(),
      0,
      'Mermaid preview must not report a conversion error'
    );
    const insertButton = diagramDialog.getByRole('button', { name: 'Insert', exact: true });
    await insertButton.waitFor({ state: 'visible' });
    assert.equal(await insertButton.isEnabled(), true, 'Mermaid Insert must be enabled');
    // The preview can replace the Insert button during a click. Ctrl+Enter is
    // Excalidraw's native keyboard submit for the same Mermaid Insert action.
    await mermaidInput.press('Control+Enter');
    await diagramDialog.waitFor({ state: 'hidden' });

    stage = 'mermaid-save';
    await waitForHostDirty('host dirty after Mermaid insertion');
    await saveButton.click();
    stage = 'mermaid-readback';
    const mermaidSaved = await poll(
      () => {
        const content = fs.readFileSync(drawingPath, 'utf8');
        const json = JSON.parse(content);
        const elements = (json.elements || []).filter((element) => !element.isDeleted);
        const labels = new Set(
          elements
            .filter((element) => element.type === 'text')
            .map((element) => element.originalText)
        );
        const hasEdge = elements.some(
          (element) => element.type === 'arrow' || element.type === 'line'
        );
        const previousElementCount = saved.json.elements.filter(
          (element) => !element.isDeleted
        ).length;
        const fixtureText = elements.find((element) => element.id === 'smoke-text');
        return labels.has('A') &&
          labels.has('B') &&
          hasEdge &&
          elements.length > previousElementCount &&
          fixtureText?.originalText === AFTER
          ? { content, json, elements, stat: fs.statSync(drawingPath) }
          : null;
      },
      15_000,
      'Mermaid generated graph disk Save readback'
    );
    assert.ok(
      mermaidSaved.stat.mtimeMs > saved.stat.mtimeMs,
      'Mermaid Save must advance the file mtime'
    );
    assert.notEqual(mermaidSaved.content, saved.content, 'Mermaid Save must change disk JSON');
    await poll(
      async () => ((await editorTab.innerText()).includes('•') ? null : true),
      5_000,
      'host clean after Mermaid Save'
    );
    stage = 'diagnostics';
    const consoleErrors = diagnostics.console.filter((message) => message.type === 'error');
    const unexpectedConsoleErrors = consoleErrors.filter(
      (message) => !isKnownExcalidrawFontConsole(message)
    );
    const unexpectedRequestFailures = diagnostics.requestFailed.filter(
      (request) => !isKnownExcalidrawFontRequest(request)
    );
    assert.deepEqual(
      unexpectedConsoleErrors,
      [],
      `Renderer/extension emitted unexpected console errors:\n${JSON.stringify(unexpectedConsoleErrors, null, 2)}`
    );
    assert.deepEqual(
      diagnostics.pageErrors,
      [],
      `Renderer/extension emitted page errors:\n${JSON.stringify(diagnostics.pageErrors, null, 2)}`
    );
    assert.deepEqual(
      unexpectedRequestFailures,
      [],
      `Renderer/extension emitted unexpected failed requests:\n${JSON.stringify(unexpectedRequestFailures, null, 2)}`
    );
    assert.deepEqual(
      diagnostics.notFoundResponses,
      [],
      `Renderer/extension received HTTP 404 responses:\n${JSON.stringify(diagnostics.notFoundResponses, null, 2)}`
    );
    diagnostics.summary = {
      consoleMessages: diagnostics.console.length,
      consoleErrors: consoleErrors.length,
      pageErrors: diagnostics.pageErrors.length,
      requestFailed: diagnostics.requestFailed.length,
      notFoundResponses: diagnostics.notFoundResponses.length,
      knownFontFallbacks: diagnostics.knownFontFallbacks.total,
      unexpectedFailures: diagnostics.unexpectedFailures.total,
      savedElementCount: mermaidSaved.elements.length,
    };
    stage = 'success';
    diagnostics.ok = true;
    saveDiagnostics();

    console.log(
      `Packaged Excalidraw smoke passed: real Add Location + canvas fixture render + ` +
        `bound-text edit + host Save + disk element/version readback + Mermaid lazy preview/Insert ` +
        `+ generated graph Save (${mermaidSaved.elements.length} elements).`
    );
    console.log(`Excalidraw smoke diagnostics: ${diagnosticsPath}`);
  } catch (error) {
    diagnostics.ok = false;
    diagnostics.failure = { stage, error: errorText(error) };
    if (page) {
      try {
        diagnostics.hostFileContentMessages = await readHostFileContentMessages(page);
      } catch (bridgeError) {
        diagnostics.hostFileContentMessagesError = errorText(bridgeError);
      }
      try {
        diagnostics.failureScreenshot = path.join(outputDirectory, 'failure.png');
        await page.screenshot({ path: diagnostics.failureScreenshot, fullPage: true });
      } catch (screenshotError) {
        diagnostics.failureScreenshotError = errorText(screenshotError);
      }
    }
    try {
      diagnostics.diskAtFailure = {
        path: drawingPath,
        content: fs.readFileSync(drawingPath, 'utf8'),
        mtimeMs: fs.statSync(drawingPath).mtimeMs,
      };
    } catch (diskError) {
      diagnostics.diskAtFailureError = errorText(diskError);
    }
    saveDiagnostics();
    console.error(`Excalidraw smoke diagnostics: ${diagnosticsPath}`);
    throw error;
  } finally {
    stage = 'cleanup';
    if (electronApp) {
      try {
        await withTimeout(electronApp.close(), 10_000, 'Electron Excalidraw shutdown');
      } catch (error) {
        electronApp.process().kill();
        diagnostics.ok = false;
        diagnostics.cleanupErrors.push(errorText(error));
        console.error('Electron Excalidraw shutdown failed; killed the process:', error);
        process.exitCode = 1;
      }
    }
    clearTimeout(watchdog);
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (error) {
      diagnostics.ok = false;
      diagnostics.cleanupErrors.push(errorText(error));
      console.warn('Could not remove temporary Excalidraw smoke data:', error);
      process.exitCode = 1;
    }
    diagnostics.finishedAt = new Date().toISOString();
    saveDiagnostics();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
