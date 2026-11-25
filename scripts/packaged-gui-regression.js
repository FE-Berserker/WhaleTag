#!/usr/bin/env node

/**
 * Repeatable GUI regression for the accessibility/layout fixes.
 *
 * Default (the same unpacked artifact as packaged-gui-smoke.js):
 *   node scripts/packaged-gui-regression.js [path/to/WhaleTag.exe]
 *
 * Quick run against the current production build without repackaging:
 *   WHALETAG_GUI_USE_CURRENT_BUILD=1 node scripts/packaged-gui-regression.js
 *
 * Optional overrides:
 *   WHALETAG_GUI_EXECUTABLE  Electron/WhaleTag executable path
 *   WHALETAG_GUI_MAIN        main.js argument (required when using electron.exe)
 *   WHALETAG_GUI_ARTIFACTS_DIR  parent for the unique output directory
 *
 * Every run writes below artifacts/packaged-gui-regression-* by default. The
 * fixture, isolated Windows profile, report and screenshots never share state
 * with another run or with the developer's real WhaleTag profile.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron, expect } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'release', 'app', 'dist', 'main', 'main.js');
const DEFAULT_EXECUTABLE = path.join(
  ROOT,
  'release',
  'build',
  'win-unpacked',
  'WhaleTag.exe'
);
const useCurrentBuild = process.env.WHALETAG_GUI_USE_CURRENT_BUILD === '1';
const executablePath = path.resolve(
  process.env.WHALETAG_GUI_EXECUTABLE ||
    (useCurrentBuild ? require('electron') : process.argv[2] || DEFAULT_EXECUTABLE)
);
const entryPoint = process.env.WHALETAG_GUI_MAIN
  ? path.resolve(process.env.WHALETAG_GUI_MAIN)
  : useCurrentBuild
    ? MAIN
    : null;
const artifactsParent = path.resolve(
  process.env.WHALETAG_GUI_ARTIFACTS_DIR || path.join(ROOT, 'artifacts')
);

// 1x1 transparent PNG (the same bytes packaged-gui-smoke.js uses). The gallery
// perspective only lists media entries, so the regression fixture needs real
// images before the view-cycle / arrow-navigation steps can assert anything.
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function errorText(error) {
  return String((error && error.stack) || error);
}

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
    `${label} timed out after ${milliseconds}ms${lastError ? `: ${errorText(lastError)}` : ''}`
  );
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('Packaged GUI regression currently supports Windows artifacts only');
  }
  if (!fs.existsSync(executablePath)) {
    throw new Error(
      `GUI executable not found: ${executablePath}\n` +
        'Build the default artifact with: npm run package:win -- --dir\n' +
        'Or set WHALETAG_GUI_USE_CURRENT_BUILD=1 after: npm run build'
    );
  }
  if (entryPoint && !fs.existsSync(entryPoint)) {
    throw new Error(`GUI main entry point not found: ${entryPoint}\nBuild it with: npm run build`);
  }

  fs.mkdirSync(artifactsParent, { recursive: true });
  const outputDirectory = fs.mkdtempSync(
    path.join(artifactsParent, 'packaged-gui-regression-')
  );
  const runtimeRoot = path.join(outputDirectory, 'runtime');
  const fixtureRoot = path.join(outputDirectory, 'fixture');
  const fixtureFile = path.join(fixtureRoot, 'plain.txt');
  const fixtureModified = new Date('2001-02-03T04:05:06.000Z');
  const env = {
    ...process.env,
    APPDATA: path.join(runtimeRoot, 'appdata'),
    LOCALAPPDATA: path.join(runtimeRoot, 'local-appdata'),
    TEMP: path.join(runtimeRoot, 'tmp'),
    TMP: path.join(runtimeRoot, 'tmp'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const directory of [
    runtimeRoot,
    fixtureRoot,
    path.join(fixtureRoot, 'Nested folder'),
    env.APPDATA,
    env.LOCALAPPDATA,
    env.TEMP,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(fixtureFile, 'WhaleTag packaged GUI regression\n', 'utf8');
  fs.writeFileSync(path.join(fixtureRoot, 'Nested folder', 'nested.md'), '# Nested\n', 'utf8');
  // Three media fixtures: gallery navigation needs more than two tiles so a
  // single ArrowRight step can be told apart from a wrap-around.
  const fixtureImages = ['alpha.png', 'beta.png', 'gamma.png'].map((name) => {
    const imagePath = path.join(fixtureRoot, name);
    fs.writeFileSync(imagePath, Buffer.from(PNG_1X1_BASE64, 'base64'));
    return imagePath;
  });
  // An old, fixed timestamp stays absolute even if the user-facing list date
  // preference is relative. This makes the Chinese date assertion deterministic.
  fs.utimesSync(fixtureFile, fixtureModified, fixtureModified);

  const report = {
    name: 'packaged-gui-regression',
    startedAt: new Date().toISOString(),
    launch: {
      executablePath,
      entryPoint,
      currentBuildOverride: useCurrentBuild,
    },
    outputDirectory,
    steps: [],
    screenshots: [],
    console: [],
    // Console output from extension iframes (whale-extension://…). It is kept
    // for diagnostics but audited separately from the host renderer: extension
    // pages are third-party content and Chromium reports some of their CSP
    // meta-tag limitations as errors on every load.
    extensionConsole: [],
    pageErrors: [],
    requestFailed: [],
    notFoundResponses: [],
    limitations: [
      'The native OS directory picker is bridged to the isolated fixture; native dialog chrome is not automated.',
      'Layout checks assert horizontal geometry, not pixel-by-pixel visual diffs.',
      'Windows is covered; macOS/Linux packages and non-English languages other than Simplified Chinese are not exercised.',
      'This is a cold, isolated profile; migration from an existing user profile is not exercised.',
    ],
  };
  const reportPath = path.join(outputDirectory, 'result.json');
  const saveReport = () => {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  };
  saveReport();

  let app;
  let page;
  let currentStep = 'setup';
  let screenshotSequence = 0;

  async function capture(name) {
    screenshotSequence += 1;
    const safeName = name.replace(/[^a-z0-9_-]/gi, '-');
    const file = `${String(screenshotSequence).padStart(2, '0')}-${safeName}.png`;
    const state = await page.evaluate(() => ({
      viewport: { width: innerWidth, height: innerHeight },
      lang: document.documentElement.lang,
      bodyScroll: {
        width: document.body.scrollWidth,
        height: document.body.scrollHeight,
      },
      documentScroll: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
    }));
    await page.screenshot({
      path: path.join(outputDirectory, file),
      animations: 'disabled',
    });
    const snapshot = { name, file, ...state };
    report.screenshots.push(snapshot);
    saveReport();
    return snapshot;
  }

  async function step(name, fn) {
    currentStep = name;
    const entry = { name, startedAt: new Date().toISOString() };
    report.steps.push(entry);
    saveReport();
    try {
      entry.data = await fn();
      entry.ok = true;
      entry.finishedAt = new Date().toISOString();
      saveReport();
      console.log(`PASS ${name}`);
      return entry.data;
    } catch (error) {
      entry.ok = false;
      entry.error = errorText(error);
      entry.finishedAt = new Date().toISOString();
      saveReport();
      if (page && !page.isClosed()) {
        try {
          await capture(`FAIL-${name}`);
        } catch (screenshotError) {
          entry.screenshotError = errorText(screenshotError);
          saveReport();
        }
      }
      throw new Error(`Step "${name}" failed:\n${errorText(error)}`);
    }
  }

  async function setContentSize(width, height) {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length !== 1) {
          throw new Error(`Expected one BrowserWindow, found ${windows.length}`);
        }
        windows[0].setContentSize(size.width, size.height);
      },
      { width, height }
    );
    return poll(
      async () => {
        const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        // Windows can drop one device pixel from the requested content width
        // when the unpackaged electron.exe hosts the current build
        // (1440 -> 1439). Treat ±1px width as the same layout bucket; height
        // must still be at least the requested value (720x480 -> 720x482).
        return Math.abs(actual.width - width) <= 1 && actual.height >= height
          ? actual
          : null;
      },
      5_000,
      `resize renderer to ${width}x${height}`
    );
  }

  async function openSettings() {
    const button = page.getByTestId('settings-button');
    assert.equal(await button.count(), 1, 'Expected exactly one Settings button');
    await button.click();
    const dialog = page.getByTestId('settings-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await dialog.count(), 1, 'Expected exactly one Settings dialog');
    return dialog;
  }

  async function closeSettings(dialog) {
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
  }

  /**
   * The view switcher folds six specialized perspectives into a "More" menu
   * below a 720px header width. The fold state comes from the header's own
   * ResizeObserver, so a window resize can leave it mid-transition for a frame
   * or two. Sample the state until two observations agree before clicking.
   */
  async function waitForStableViewSwitcher() {
    await poll(
      async () => {
        const sample = async () => ({
          overflow: await page.getByTestId('view-overflow').count(),
          list: await page
            .getByRole('button', { name: 'List view', exact: true })
            .count(),
        });
        const first = await sample();
        await delay(150);
        const second = await sample();
        return first.overflow === second.overflow && first.list === second.list
          ? true
          : null;
      },
      5_000,
      'file-list view switcher to settle'
    );
  }

  /**
   * Switch the file-list perspective through the real header control.
   *
   * List / grid / gallery are always inline; the six specialized perspectives
   * are inline in the wide layout and move into the `view-overflow` menu when
   * the header folds. Try inline first, then the menu, and retry once if the
   * header re-renders between resolving and clicking the control.
   */
  async function selectView(label) {
    await waitForStableViewSwitcher();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const inline = page.getByRole('button', { name: label, exact: true });
      if ((await inline.count()) > 0) {
        try {
          await inline.first().click({ timeout: 3_000 });
          return 'inline-toggle';
        } catch {
          // The header re-folded between count and click; retry below.
        }
      }
      const overflow = page.getByTestId('view-overflow');
      if ((await overflow.count()) > 0) {
        try {
          await overflow.first().click({ timeout: 3_000 });
          const item = page.getByRole('menuitem', { name: label, exact: true });
          await item.waitFor({ state: 'visible', timeout: 3_000 });
          await item.click({ timeout: 3_000 });
          return 'overflow-menu';
        } catch {
          // The menu was closed by a re-fold; retry below.
        }
      }
      await waitForStableViewSwitcher();
    }
    throw new Error(`Could not select the "${label}" view after 3 attempts`);
  }

  /** Wait for a perspective's root container and prove it is actually visible. */
  async function assertViewContainer(testId, label) {
    const container = page.getByTestId(testId);
    await poll(
      async () => ((await container.count()) > 0 ? true : null),
      10_000,
      `${label} container mounted`
    );
    await container.first().waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(
      await container.first().isVisible(),
      true,
      `${label} container must be visible`
    );
    return container.first();
  }

  // MUI Select does not inherit the adjacent Field typography as an accessible
  // name. Scope from that exact label to its Field instead of relying on the
  // combobox's position among unrelated selects.
  function settingsField(dialog, label) {
    return dialog.getByText(label, { exact: true }).locator('..').locator('..');
  }

  async function selectSettingsOption(dialog, fieldLabel, option) {
    const combobox = settingsField(dialog, fieldLabel).getByRole('combobox');
    await expect(combobox).toHaveCount(1);
    await combobox.click();
    const optionLocator = page.getByRole('option', { name: option, exact: true });
    await expect(optionLocator).toHaveCount(1);
    await optionLocator.click();
  }

  /**
   * The theme picker is a tile radio group, not an MUI Select: a dropdown of
   * eleven theme names gave no hint of what a theme looks like.
   */
  async function selectTheme(dialog, option) {
    const group = dialog.getByRole('radiogroup', { name: 'Theme', exact: true });
    await expect(group).toHaveCount(1);
    const tile = group.getByRole('radio', { name: option, exact: true });
    await expect(tile).toHaveCount(1);
    await tile.click();
    await expect(tile).toHaveAttribute('aria-checked', 'true');
  }

  async function assertFocus(locator, label) {
    assert.equal(
      await locator.evaluate((element) => element === document.activeElement),
      true,
      `${label} must retain focus`
    );
  }

  async function readHorizontalGeometry() {
    return page.evaluate(() => ({
      viewport: { width: innerWidth, height: innerHeight },
      bodyScrollWidth: document.body.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
    }));
  }

  async function assertNoHorizontalOverflow(label) {
    const geometry = await readHorizontalGeometry();
    assert.ok(
      geometry.bodyScrollWidth <= geometry.viewport.width,
      `${label}: body scrollWidth ${geometry.bodyScrollWidth} exceeds viewport ${geometry.viewport.width}`
    );
    assert.ok(
      geometry.documentScrollWidth <= geometry.viewport.width,
      `${label}: document scrollWidth ${geometry.documentScrollWidth} exceeds viewport ${geometry.viewport.width}`
    );
    return geometry;
  }

  async function assertDialogPaperFitsViewport(dialog, label) {
    // A fixed MUI Modal can leave body/document geometry unchanged even when
    // its Paper is clipped or scrolls horizontally. Assert the actual Paper.
    const paper = dialog.locator('.MuiDialog-paper');
    await expect(paper).toHaveCount(1);
    await expect(paper).toBeVisible();
    return poll(
      async () => {
        const geometry = await paper.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            viewport: { width: innerWidth, height: innerHeight },
            rect: {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            },
            client: { width: element.clientWidth, height: element.clientHeight },
            scroll: { width: element.scrollWidth, height: element.scrollHeight },
            overflow: { x: style.overflowX, y: style.overflowY },
          };
        });
        const { viewport, rect, client, scroll } = geometry;
        assert.ok(rect.width > 0 && rect.height > 0, `${label}: Dialog Paper must be non-empty`);
        assert.ok(
          rect.left >= -1 && rect.right <= viewport.width + 1,
          `${label}: Dialog Paper horizontal bounds ${rect.left}..${rect.right} exceed viewport ${viewport.width}`
        );
        assert.ok(
          rect.top >= -1 && rect.bottom <= viewport.height + 1,
          `${label}: Dialog Paper vertical bounds ${rect.top}..${rect.bottom} exceed viewport ${viewport.height}`
        );
        assert.ok(
          scroll.width <= client.width,
          `${label}: Dialog Paper scrollWidth ${scroll.width} exceeds clientWidth ${client.width}`
        );
        return geometry;
      },
      5_000,
      `${label} Dialog Paper geometry`
    );
  }

  try {
    app = await electron.launch({
      executablePath,
      args: entryPoint ? [entryPoint] : [],
      cwd: ROOT,
      env,
      timeout: 30_000,
    });
    page = await withTimeout(app.firstWindow(), 20_000, 'first renderer window');
    page.setDefaultTimeout(10_000);
    page.on('console', (message) => {
      const entry = {
        type: message.type(),
        text: message.text(),
        location: message.location(),
        // Milliseconds since the report started, so a failure in the final
        // console audit can be tied to the step that produced it.
        elapsedMs: Date.now() - Date.parse(report.startedAt),
      };
      // Extension iframes share this page's console. Keep their output out of
      // the host-renderer audit: Chromium flags e.g. `frame-ancestors` inside
      // a <meta> CSP as an error on every extension load, which is a property
      // of the extension HTML, not of the host app.
      const fromExtension = (entry.location?.url ?? '').startsWith('whale-extension://');
      (fromExtension ? report.extensionConsole : report.console).push(entry);
      saveReport();
    });
    page.on('pageerror', (error) => {
      report.pageErrors.push(errorText(error));
      saveReport();
    });
    page.on('requestfailed', (request) => {
      report.requestFailed.push({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        errorText: request.failure()?.errorText || 'unknown request failure',
      });
      saveReport();
    });
    page.on('response', (response) => {
      if (response.status() === 404) {
        report.notFoundResponses.push({ url: response.url(), status: 404 });
        saveReport();
      }
    });

    await step('cold-start', async () => {
      await withTimeout(
        page.waitForLoadState('domcontentloaded'),
        20_000,
        'renderer DOM load'
      );
      const welcome = page.getByRole('heading', {
        name: 'Welcome to WhaleTag',
        exact: true,
      });
      await welcome.waitFor({ state: 'visible', timeout: 30_000 });
      const url = page.url();
      assert.ok(url.startsWith('file:'), `Expected a production file renderer, got ${url}`);
      assert.ok(
        url.includes('app.asar') || url.includes('/release/app/dist/'),
        `Renderer URL is neither packaged nor the current production build: ${url}`
      );
      assert.equal(
        await page.locator('html').getAttribute('lang'),
        'en',
        'A cold isolated profile must start in English'
      );
      const viewport = await setContentSize(1440, 900);
      await capture('cold-start-en-1440x900');
      return { url, viewport };
    });

    await step('add-location', async () => {
      // Native dialogs are outside Playwright. Bridge only this disposable main
      // process, then use the real Add Location dialog and directory scan.
      await app.evaluate(({ dialog }, root) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
      }, fs.realpathSync(fixtureRoot));

      // The heading's direct parent is the WelcomePanel, distinguishing its
      // primary button from the Sidebar's identically named icon button.
      const welcomePanel = page
        .getByRole('heading', { name: 'Welcome to WhaleTag', exact: true })
        .locator('..');
      await welcomePanel
        .getByRole('button', { name: 'Add Location', exact: true })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Add Location', exact: true });
      await dialog.waitFor({ state: 'visible' });
      await dialog
        .getByRole('textbox', { name: 'Location name', exact: true })
        .fill('Packaged GUI regression');
      await dialog.getByRole('button', { name: 'Browse', exact: true }).click();
      const pathInput = dialog.getByRole('textbox', { name: 'Folder path', exact: true });
      await pathInput.waitFor({ state: 'visible' });
      const selectedPath = await poll(
        async () => (await pathInput.inputValue()) || null,
        5_000,
        'bridged fixture path'
      );
      assert.equal(selectedPath, fs.realpathSync(fixtureRoot));
      await dialog.getByRole('button', { name: 'Add', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });

      const row = page.getByTitle('plain.txt', { exact: true });
      await row.waitFor({ state: 'visible', timeout: 30_000 });
      assert.equal(await row.count(), 1, 'Expected exactly one fixture row');
      const nested = page.getByTitle('Nested folder', { exact: true });
      await nested.waitFor({ state: 'visible' });
      assert.equal(await nested.count(), 1, 'Expected the nested fixture directory');
      return {
        fixtureRoot,
        rowCount: 1,
        nestedDirectory: true,
        mediaFixtures: fixtureImages.length,
      };
    });

    await step('six-icon-accessible-names', async () => {
      // The two drawing buttons render only after the extension manifest
      // registry has resolved (useNewExcalidraw/useNewDrawio `available`).
      // Under CPU contention that IPC round-trip can settle after the file
      // rows are already on screen, so wait for both instead of racing them.
      await poll(
        async () => {
          const excalidraw = await page
            .getByRole('button', { name: 'New Excalidraw drawing', exact: true })
            .count();
          const drawio = await page
            .getByRole('button', { name: 'New Draw.io diagram', exact: true })
            .count();
          return excalidraw === 1 && drawio === 1 ? true : null;
        },
        15_000,
        'sidebar drawing actions to appear'
      );
      const names = [
        'New Excalidraw drawing',
        'New Draw.io diagram',
        'Up one level',
        'Back',
        'Forward',
        'Recent locations',
      ];
      const observed = {};
      for (const name of names) {
        const button = page.getByRole('button', { name, exact: true });
        assert.equal(await button.count(), 1, `Expected exactly one "${name}" button`);
        await button.waitFor({ state: 'visible' });
        assert.equal(
          await button.getAttribute('aria-label'),
          name,
          `"${name}" must come from an explicit accessible label`
        );
        observed[name] = await button.ariaSnapshot();
      }
      return observed;
    });

    await step('settings-four-switches-no-static-enabled', async () => {
      const states = {};
      async function verifySwitches(dialog, labels) {
        assert.equal(
          await dialog.getByRole('switch').count(),
          labels.length,
          `Unexpected Switch count in the ${labels.join(', ')} section`
        );
        for (const label of labels) {
          const control = dialog.getByRole('switch', { name: label, exact: true });
          assert.equal(await control.count(), 1, `Expected exactly one "${label}" Switch`);
          await control.waitFor({ state: 'visible' });
          const initial = await control.isChecked();
          await control.click();
          assert.equal(await control.isChecked(), !initial, `${label} did not toggle`);
          await control.click();
          assert.equal(await control.isChecked(), initial, `${label} did not restore`);
          states[label] = { initial, restored: await control.isChecked() };
        }
        assert.equal(
          await dialog.getByText('Enabled', { exact: true }).count(),
          0,
          'A Switch must expose checked state instead of a static Enabled label'
        );
      }

      const dialog = await openSettings();
      await verifySwitches(dialog, [
        'Move deleted files to trash',
        'Show hidden files',
        'Show lunar calendar',
      ]);
      await capture('settings-general-switches');
      await page.getByTestId('settings-nav-notifications').click();
      await verifySwitches(dialog, ['Task reminder']);
      await capture('settings-task-reminder-switch');
      await closeSettings(dialog);
      return states;
    });

    await step('shortcut-search-label-and-focus', async () => {
      const dialog = await openSettings();
      await page.getByTestId('settings-nav-keyboard').click();
      const search = dialog.getByRole('textbox', {
        name: 'Search shortcuts…',
        exact: true,
      });
      assert.equal(await search.count(), 1, 'Expected exactly one shortcut search');
      await search.click();
      await search.fill('save');
      await assertFocus(search, 'Shortcut search');
      assert.equal(await search.inputValue(), 'save');
      const focusRing = await search.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          outlineOffset: style.outlineOffset,
        };
      });
      assert.deepEqual(focusRing, {
        outlineStyle: 'solid',
        outlineWidth: '2px',
        outlineOffset: '2px',
      });
      await capture('settings-shortcut-search-focus');
      await closeSettings(dialog);
      return { label: 'Search shortcuts…', value: 'save', focusRing };
    });

    await step('theme-frosted-mint-dark-light', async () => {
      const expectedThemes = [
        {
          option: 'Frosted Mint',
          background: 'rgb(240, 253, 250)',
          color: 'rgb(19, 78, 74)',
        },
        {
          option: 'Dark',
          background: 'rgb(15, 15, 16)',
          color: 'rgb(250, 250, 250)',
        },
        {
          option: 'Light',
          background: 'rgb(248, 250, 252)',
          color: 'rgb(15, 23, 42)',
        },
      ];
      const observed = [];
      for (const expected of expectedThemes) {
        const dialog = await openSettings();
        await selectTheme(dialog, expected.option);
        const theme = await poll(
          async () => {
            const value = await page.evaluate(() => ({
              background: getComputedStyle(document.body).backgroundColor,
              color: getComputedStyle(document.body).color,
              lang: document.documentElement.lang,
            }));
            return value.background === expected.background && value.color === expected.color
              ? value
              : null;
          },
          5_000,
          `${expected.option} body colors`
        );
        assert.equal(theme.lang, 'en');
        observed.push({ option: expected.option, ...theme });
        await capture(`theme-${expected.option.toLowerCase().replaceAll(' ', '-')}`);
        await closeSettings(dialog);
      }
      return observed;
    });

    await step('advanced-search-lazy-ever-opened', async () => {
      let button = page.getByRole('button', { name: 'Advanced search', exact: true });
      if ((await button.count()) === 0) {
        // Advanced search is available once the location index is ready. Fresh
        // fixtures may be idle (or have a stale empty index) until explicitly built.
        const buildIndex = page.getByRole('button', { name: 'Build Index', exact: true });
        const rebuildIndex = page.getByRole('button', { name: 'Rebuild Index', exact: true });
        const buildCount = await buildIndex.count();
        const rebuildCount = await rebuildIndex.count();
        assert.equal(
          buildCount + rebuildCount,
          1,
          'Expected Advanced search or exactly one index build action'
        );
        await (buildCount === 1 ? buildIndex : rebuildIndex).click();
        await poll(
          async () => ((await button.count()) === 1 ? button : null),
          30_000,
          'location index ready for Advanced search'
        );
      }
      button = page.getByRole('button', { name: 'Advanced search', exact: true });
      assert.equal(await button.count(), 1, 'Expected exactly one Advanced search button');
      await button.click();
      const dialog = page.getByRole('dialog', { name: 'Advanced search', exact: true });
      await dialog.waitFor({ state: 'visible', timeout: 20_000 });
      const input = dialog.getByRole('textbox', {
        name: 'File name contains',
        exact: true,
      });
      assert.equal(await input.count(), 1, 'Expected exactly one File name contains input');
      await input.fill('lazy-state');
      assert.equal(await input.inputValue(), 'lazy-state');
      await capture('advanced-search-first-open');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });

      // Reopen the same mounted lazy component: everOpened must preserve its
      // local state instead of remounting/resetting it or requesting it again.
      await button.click();
      await dialog.waitFor({ state: 'visible', timeout: 10_000 });
      assert.equal(
        await input.inputValue(),
        'lazy-state',
        'Advanced search input must survive Close and reopen'
      );
      await capture('advanced-search-reopen-state');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.deepEqual(report.pageErrors, [], 'Advanced search emitted a page error');
      assert.deepEqual(
        report.requestFailed,
        [],
        'Advanced search emitted a failed request (including file:// lazy chunks)'
      );
      assert.deepEqual(
        report.notFoundResponses,
        [],
        'Advanced search emitted an HTTP 404 response'
      );
      return { firstOpen: true, reopened: true, retainedValue: 'lazy-state' };
    });

    await step('simplified-chinese-lang-and-date', async () => {
      const dialog = await openSettings();
      await selectSettingsOption(dialog, 'Language', '简体中文');
      await poll(
        async () => (await page.locator('html').getAttribute('lang')) === 'zh',
        5_000,
        'Simplified Chinese html lang'
      );
      // The rebuilt dialog titles itself with a styled span (no heading role):
      // the title element is addressed by the id the dialog's label points at.
      await expect(dialog.locator('#settings-dialog-title')).toHaveText('设置');
      await capture('settings-simplified-chinese');
      await closeSettings(dialog);

      const expectedDate = await page.evaluate(
        (timestamp) => new Date(timestamp).toLocaleDateString('zh'),
        fixtureModified.toISOString()
      );
      const row = page.getByTitle('plain.txt', { exact: true });
      const date = row.getByText(expectedDate, { exact: true });
      assert.equal(await date.count(), 1, `Expected one Chinese-localized date: ${expectedDate}`);
      await date.waitFor({ state: 'visible' });
      assert.equal(
        await date.getAttribute('aria-label'),
        `修改时间：${expectedDate}`,
        'The modified-date accessible label must use Simplified Chinese too'
      );
      await capture('main-simplified-chinese-date');

      // Restore English so the following separator and layout checks exercise
      // the same accessible names as the earlier steps.
      const englishDialog = await openSettings();
      await selectSettingsOption(englishDialog, '语言', 'English');
      await poll(
        async () => (await page.locator('html').getAttribute('lang')) === 'en',
        5_000,
        'restore English html lang'
      );
      await closeSettings(englishDialog);
      return { lang: 'zh', date: expectedDate, ariaLabel: `修改时间：${expectedDate}` };
    });

    await step('properties-separator-consecutive-keyboard-resize', async () => {
      await setContentSize(1440, 900);
      const row = page.getByTitle('plain.txt', { exact: true });
      await row.click();
      let separator = page.getByRole('separator', {
        name: 'Resize File properties column',
        exact: true,
      });
      if ((await separator.count()) === 0) {
        const show = page.getByRole('button', { name: 'Show properties', exact: true });
        assert.equal(await show.count(), 1, 'Expected one Show properties button');
        await show.click();
        separator = page.getByRole('separator', {
          name: 'Resize File properties column',
          exact: true,
        });
      }
      assert.equal(await separator.count(), 1, 'Expected exactly one PropertiesTray separator');
      assert.equal(
        await separator.getAttribute('data-testid'),
        'properties-tray-resize-handle'
      );
      await separator.waitFor({ state: 'visible' });
      await separator.focus();
      await assertFocus(separator, 'PropertiesTray separator before resizing');
      const initial = Number(await separator.getAttribute('aria-valuenow'));
      assert.equal(initial, 300, 'Cold profile should use the 300px PropertiesTray default');

      const sequence = [
        { key: 'ArrowRight', expected: initial - 10 },
        { key: 'ArrowRight', expected: initial - 20 },
        { key: 'ArrowLeft', expected: initial - 10 },
        { key: 'ArrowLeft', expected: initial },
      ];
      const values = [initial];
      report.propertiesResize = { initial, events: [] };
      const readActiveElement = () =>
        page.evaluate(() => {
          const active = document.activeElement;
          return {
            tag: active && active.tagName,
            testid: active && active.getAttribute('data-testid'),
            role: active && active.getAttribute('role'),
            ariaLabel: active && active.getAttribute('aria-label'),
            separatorCount: document.querySelectorAll(
              '[data-testid="properties-tray-resize-handle"]'
            ).length,
          };
        });
      for (const { key, expected } of sequence) {
        // Deliberately use page.keyboard after one initial focus: locator.press
        // would refocus the handle and could hide a focus-loss regression.
        await page.keyboard.press(key);
        report.propertiesResize.events.push({
          key,
          expected,
          activeElement: await readActiveElement(),
        });
        saveReport();
        await poll(
          async () =>
            (await separator.getAttribute('aria-valuenow')) === String(expected)
              ? expected
              : null,
          3_000,
          `${key} PropertiesTray width ${expected}`
        );
        await assertFocus(separator, `PropertiesTray separator after ${key}`);
        values.push(expected);
      }
      await capture('properties-separator-keyboard-resize');
      return { keys: sequence.map((item) => item.key), values, focusRetained: true };
    });

    for (const [width, height] of [
      [1024, 640],
      [720, 480],
    ]) {
      await step(`no-horizontal-overflow-${width}x${height}`, async () => {
        const viewport = await setContentSize(width, height);
        const geometry = await assertNoHorizontalOverflow(`main ${width}x${height}`);
        await capture(`main-${width}x${height}`);
        let settingsGeometry = null;
        if (width === 720) {
          const dialog = await openSettings();
          const modalGeometry = await assertNoHorizontalOverflow('Settings 720x480 Modal');
          const dialogPaper = await assertDialogPaperFitsViewport(dialog, 'Settings 720x480');
          settingsGeometry = { ...modalGeometry, dialogPaper };
          await capture('settings-720x480');
          await closeSettings(dialog);
        }
        return { requested: { width, height }, viewport, geometry, settingsGeometry };
      });
    }

    // The five steps below intentionally run after the layout/resize matrix and
    // before the final console audit: each one owns its view mode, window size
    // and extension tabs, so earlier list-view/date/properties assertions keep
    // their original preconditions, and the error audit still runs last.
    await step('view-cycle', async () => {
      await setContentSize(1440, 900);
      const pageErrorsBefore = report.pageErrors.length;
      const visited = [];
      const record = (label, testId, control) => {
        visited.push({
          label,
          testId,
          control,
          pageErrors: report.pageErrors.length,
        });
        assert.equal(
          report.pageErrors.length,
          pageErrorsBefore,
          `${label} emitted a page error`
        );
      };
      const visit = async (label, testId) => {
        const control = await selectView(label);
        await assertViewContainer(testId, label);
        record(label, testId, control);
        return control;
      };

      await visit('List view', 'view-list');
      await visit('Gallery view', 'gallery-view');
      await capture('view-cycle-gallery');
      await visit('Task view', 'task-view');

      // Board / Matrix / Gantt are Task sub-modes, not top-level perspectives.
      const taskSubViews = [
        ['task-toggle-kanban', 'kanban-view', 'Board'],
        ['task-toggle-matrix', 'matrix-view', 'Matrix'],
      ];
      for (const [toggleTestId, containerTestId, label] of taskSubViews) {
        const toggle = page.getByTestId(toggleTestId);
        await toggle.waitFor({ state: 'visible' });
        await toggle.click();
        await assertViewContainer(containerTestId, label);
        record(label, containerTestId, 'task-toggle');
      }

      await visit('Calendar view', 'calendar-view');
      const ganttToggleControl = await selectView('Task view');
      await assertViewContainer('task-view', 'Task view');
      await page.getByTestId('task-toggle-gantt').click();
      await assertViewContainer('gantt-view', 'Gantt');
      record('Gantt', 'gantt-view', ganttToggleControl);

      await visit('Tag cloud', 'tagcloud-view');
      await visit('Folder visualization', 'folderviz-view');
      await visit('Knowledge graph', 'knowledge-graph-view');
      await capture('view-cycle-knowledge-graph');
      // Leave the list perspective active so later steps keep their row-based
      // locators working.
      await visit('List view', 'view-list');

      assert.deepEqual(
        report.pageErrors.slice(pageErrorsBefore),
        [],
        'The perspective cycle must not emit page errors'
      );
      return { visited, finalView: 'list', pageErrors: 0 };
    });

    await step('tab-focus-not-trapped', async () => {
      await selectView('List view');
      await assertViewContainer('view-list', 'List view');
      const list = page.getByTestId('file-list');
      await list.waitFor({ state: 'visible' });

      // Focus the element that owns the key handler. Using element.focus()
      // avoids the row-level focus effect racing the container focus that a
      // click would trigger.
      await list.evaluate((element) => element.focus());
      await poll(
        async () =>
          (await list.evaluate((element) => element === document.activeElement))
            ? true
            : null,
        5_000,
        'file-list container focus'
      );

      const readFocus = () =>
        page.evaluate(() => {
          const container = document.querySelector('[data-testid="file-list"]');
          const active = document.activeElement;
          return {
            isListContainer: active === container,
            tag: active ? active.tagName : null,
            testid: active ? active.getAttribute('data-testid') : null,
            role: active ? active.getAttribute('role') : null,
            ariaLabel: active ? active.getAttribute('aria-label') : null,
            insideListSubtree: Boolean(active && container && container.contains(active)),
          };
        });

      const before = await readFocus();
      assert.equal(before.isListContainer, true, 'The file-list container must start focused');
      await page.keyboard.press('Tab');
      const trail = [await readFocus()];
      assert.equal(
        trail[0].isListContainer,
        false,
        'Tab must move focus off the file-list container instead of being swallowed'
      );
      assert.equal(
        await page.getByTestId('view-list').isVisible(),
        true,
        'Tab must not switch the view mode (Tab is deliberately unbound)'
      );
      // Repeated Tab presses must never steer focus back into the container
      // either: the old binding swallowed Tab and cycled the perspective.
      for (let index = 0; index < 3; index += 1) {
        await page.keyboard.press('Tab');
        const state = await readFocus();
        trail.push(state);
        assert.equal(
          state.isListContainer,
          false,
          `Tab #${index + 2} must not return focus to the file-list container`
        );
        assert.equal(
          await page.getByTestId('view-list').isVisible(),
          true,
          `Tab #${index + 2} must not switch the view mode`
        );
      }
      await capture('tab-focus-left-file-list');
      return { before, trail, viewUnchanged: true };
    });

    await step('gallery-arrow-single-step', async () => {
      await selectView('Gallery view');
      const gallery = await assertViewContainer('gallery-view', 'Gallery view');
      const tiles = page.getByTestId('gallery-tile');
      await poll(
        async () => ((await tiles.count()) >= 3 ? await tiles.count() : null),
        10_000,
        'three gallery tiles'
      );

      const readTiles = () =>
        tiles.evaluateAll((nodes) =>
          nodes.map((node) => ({
            focused: node.getAttribute('data-focused') === 'true',
            selected: node.getAttribute('data-selected') === 'true',
          }))
        );

      await tiles.nth(0).click();
      await poll(
        async () => {
          const state = await readTiles();
          const selected = state.filter((tile) => tile.selected);
          return selected.length === 1 && state[0].selected ? true : null;
        },
        5_000,
        'single gallery selection after click'
      );
      const selectedBefore = await readTiles();
      const selectedIndex = selectedBefore.findIndex((tile) => tile.selected);
      const selectionSummary = page.getByText('1 selected', { exact: true });
      assert.ok(
        (await selectionSummary.count()) >= 1,
        'The header must report one selected entry'
      );

      // Give the gallery container focus so ArrowRight reaches its key handler
      // (the same handler that must keep focus navigation single-step).
      await gallery.evaluate((element) => element.focus());
      await poll(
        async () =>
          (await gallery.evaluate((element) => element === document.activeElement))
            ? true
            : null,
        5_000,
        'gallery container focus'
      );
      const before = await readTiles();
      assert.equal(
        before.filter((tile) => tile.focused).length,
        1,
        'Exactly one gallery tile must carry the focus caret'
      );
      const firstFocusedIndex = before.findIndex((tile) => tile.focused);

      await page.keyboard.press('ArrowRight');
      const afterRight = await poll(
        async () => {
          const state = await readTiles();
          return state.findIndex((tile) => tile.focused) === firstFocusedIndex + 1
            ? state
            : null;
        },
        5_000,
        'ArrowRight moves the gallery caret exactly one tile'
      );
      assert.equal(
        afterRight.filter((tile) => tile.selected).length,
        1,
        'ArrowRight must not extend the selection'
      );
      assert.equal(
        afterRight.findIndex((tile) => tile.selected),
        selectedIndex,
        'ArrowRight must not move the selected tile'
      );

      await page.keyboard.press('ArrowLeft');
      await poll(
        async () => {
          const state = await readTiles();
          return state.findIndex((tile) => tile.focused) === firstFocusedIndex
            ? state
            : null;
        },
        5_000,
        'ArrowLeft moves the gallery caret exactly one tile back'
      );
      const afterLeft = await readTiles();
      assert.equal(
        afterLeft.filter((tile) => tile.selected).length,
        1,
        'ArrowLeft must not extend the selection'
      );

      await capture('gallery-arrow-single-step');
      return {
        tileCount: before.length,
        selectedIndex,
        firstFocusedIndex,
        focusedAfterRight: firstFocusedIndex + 1,
        focusedAfterLeft: firstFocusedIndex,
        selectionCount: 1,
      };
    });

    await step('extension-open', async () => {
      await selectView('List view');
      await assertViewContainer('view-list', 'List view');
      const pageErrorsBefore = report.pageErrors.length;
      const row = page.getByTitle('plain.txt', { exact: true });
      await row.dblclick();

      const iframe = page.locator('iframe[title="Text Editor"]');
      await poll(
        async () => ((await iframe.count()) === 1 ? true : null),
        20_000,
        'Text Editor iframe mounted'
      );
      const content = page.frameLocator('iframe[title="Text Editor"]').locator('.cm-content');
      await content.waitFor({ state: 'visible', timeout: 20_000 });
      const text = await content.innerText();
      assert.match(
        text,
        /WhaleTag packaged GUI regression/,
        'The text editor iframe must render the fixture content'
      );

      const tab = page.locator('[role="tab"]').filter({ hasText: 'plain.txt' });
      assert.equal(await tab.count(), 1, 'Expected exactly one tab for plain.txt');
      await tab.waitFor({ state: 'visible' });
      assert.equal(await tab.getAttribute('title'), fixtureFile);
      const tabText = (await tab.innerText()).trim();
      assert.equal(
        tabText.includes('•'),
        false,
        'A freshly opened text editor must not be dirty'
      );
      await page.getByText('Text Editor', { exact: true }).first().waitFor({
        state: 'visible',
      });
      await capture('extension-open-text-editor');

      await tab.getByRole('button', { name: 'Close', exact: true }).click();
      await poll(
        async () => ((await iframe.count()) === 0 ? true : null),
        10_000,
        'extension iframe closed'
      );
      assert.equal(
        await page.locator('[role="tab"]').count(),
        0,
        'Closing the last extension tab must empty the tab strip'
      );
      assert.deepEqual(
        report.pageErrors.slice(pageErrorsBefore),
        [],
        'Opening and closing the extension must not emit page errors'
      );
      return { iframeTitle: 'Text Editor', contentMatched: true, tabsAfterClose: 0 };
    });

    await step('rename-no-stale-tab', async () => {
      await selectView('List view');
      await assertViewContainer('view-list', 'List view');
      const row = page.getByTitle('plain.txt', { exact: true });
      await row.dblclick();
      const iframe = page.locator('iframe[title="Text Editor"]');
      await poll(
        async () => ((await iframe.count()) === 1 ? true : null),
        20_000,
        'Text Editor iframe mounted before rename'
      );
      const oldTab = page.locator('[role="tab"]').filter({ hasText: 'plain.txt' });
      await oldTab.waitFor({ state: 'visible' });
      const tabText = (await oldTab.innerText()).trim();
      assert.equal(
        tabText.includes('•'),
        false,
        'A freshly opened text editor must not be dirty before rename'
      );

      const renameButton = page.getByTestId('extension-rename');
      await renameButton.waitFor({ state: 'visible' });
      await renameButton.click();
      const dialog = page.getByRole('dialog', { name: 'Rename', exact: true });
      await dialog.waitFor({ state: 'visible' });
      const input = dialog.getByRole('textbox', { name: 'Name', exact: true });
      assert.equal(await input.inputValue(), 'plain.txt');
      await input.fill('renamed.txt');
      await dialog.getByRole('button', { name: 'OK', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });

      const renamedPath = path.join(fixtureRoot, 'renamed.txt');
      await poll(
        async () => (fs.existsSync(renamedPath) ? true : null),
        10_000,
        'renamed fixture on disk'
      );
      assert.equal(fs.existsSync(fixtureFile), false, 'The old path must be gone after rename');

      const tabs = page.locator('[role="tab"]');
      await poll(
        async () => {
          if ((await tabs.count()) !== 1) return null;
          return (await tabs.first().getAttribute('title')) === renamedPath ? true : null;
        },
        15_000,
        'single extension tab pointing at the renamed path'
      );
      assert.equal(await tabs.count(), 1, 'Rename must not leave a stale tab behind');
      assert.equal(await tabs.first().getAttribute('title'), renamedPath);

      // The extension workspace covers the file list while a tab is open, so
      // screenshot the tab state first and only check the refreshed row after
      // closing it.
      await page.locator('iframe[title="Text Editor"]').waitFor({
        state: 'visible',
        timeout: 20_000,
      });
      await capture('rename-no-stale-tab');

      await tabs.first().getByRole('button', { name: 'Close', exact: true }).click();
      await poll(
        async () => ((await page.locator('[role="tab"]').count()) === 0 ? true : null),
        10_000,
        'renamed tab closed'
      );
      await page.getByTitle('renamed.txt', { exact: true }).waitFor({
        state: 'visible',
        timeout: 10_000,
      });
      assert.equal(
        await page.getByTitle('plain.txt', { exact: true }).count(),
        0,
        'The file list must not keep a stale plain.txt row after rename'
      );
      return { oldPath: fixtureFile, newPath: renamedPath, tabCount: 1, staleTab: false };
    });

    await step('console-page-errors-and-404-empty', async () => {
      const consoleFailures = report.console.filter(
        (message) => message.type === 'warning' || message.type === 'error'
      );
      assert.deepEqual(
        consoleFailures,
        [],
        `Renderer emitted console warnings/errors:\n${JSON.stringify(consoleFailures, null, 2)}`
      );
      assert.deepEqual(
        report.pageErrors,
        [],
        `Renderer emitted page errors:\n${JSON.stringify(report.pageErrors, null, 2)}`
      );
      assert.deepEqual(
        report.requestFailed,
        [],
        `Renderer requests failed (including file:// lazy chunks):\n${JSON.stringify(report.requestFailed, null, 2)}`
      );
      assert.deepEqual(
        report.notFoundResponses,
        [],
        `Renderer received HTTP 404 responses:\n${JSON.stringify(report.notFoundResponses, null, 2)}`
      );
      return {
        consoleMessages: report.console.length,
        consoleFailures: consoleFailures.length,
        extensionConsoleMessages: report.extensionConsole.length,
        extensionConsoleFailures: report.extensionConsole.filter(
          (message) => message.type === 'warning' || message.type === 'error'
        ).length,
        pageErrors: report.pageErrors.length,
        requestFailed: report.requestFailed.length,
        notFoundResponses: report.notFoundResponses.length,
      };
    });

    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.fatal = { step: currentStep, error: errorText(error) };
    process.exitCode = 1;
    console.error(`Packaged GUI regression failed at step "${currentStep}".`);
    console.error(errorText(error));
  } finally {
    if (app) {
      try {
        await withTimeout(app.close(), 10_000, 'Electron GUI shutdown');
      } catch (error) {
        app.process().kill();
        report.ok = false;
        report.shutdownError = errorText(error);
        process.exitCode = 1;
        console.error('Electron GUI shutdown failed; killed the process:', error);
      }
    }
    report.finishedAt = new Date().toISOString();
    saveReport();
  }

  console.log(
    `Packaged GUI regression ${report.ok ? 'PASSED' : 'FAILED'}: ${report.steps.filter((item) => item.ok).length}/${report.steps.length} steps passed.`
  );
  console.log(`Artifacts: ${outputDirectory}`);
  console.log(`Report: ${reportPath}`);
}

main().catch((error) => {
  console.error(`Packaged GUI regression failed at step "setup".`);
  console.error(errorText(error));
  process.exitCode = 1;
});
