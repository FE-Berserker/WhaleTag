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
        // Electron may enforce a slightly larger minimum height (720x480 has
        // historically produced 720x482). Width and horizontal overflow remain exact.
        return actual.width === width && actual.height >= height ? actual : null;
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
      report.console.push({
        type: message.type(),
        text: message.text(),
        location: message.location(),
      });
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
      return { fixtureRoot, rowCount: 1, nestedDirectory: true };
    });

    await step('six-icon-accessible-names', async () => {
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
        await selectSettingsOption(dialog, 'Theme', expected.option);
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
      await dialog.getByRole('heading', { name: '设置', exact: true }).waitFor({
        state: 'visible',
      });
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
