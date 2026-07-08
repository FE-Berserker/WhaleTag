/**
 * One-time migration: read the old redux-persist blob from localStorage
 * (Chromium LevelDB) and write it to the new main-process JSON file.
 *
 * Run with:
 *   npx cross-env TS_NODE_TRANSPILE_ONLY=true node -r ts-node/register -r tsconfig-paths/register scripts/migrate-localstorage-persist.ts
 */

// The host may inject ELECTRON_RUN_AS_NODE; remove it before requiring electron.
delete process.env.ELECTRON_RUN_AS_NODE;

import { app, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';

const DEV_URL = 'http://localhost:4002';

async function migrate(): Promise<void> {
  await app.whenReady();

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  await win.loadURL(DEV_URL);

  const raw = await win.webContents.executeJavaScript(
    "localStorage.getItem('persist:whale-root')"
  );

  await win.close();

  if (typeof raw !== 'string' || raw.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No legacy localStorage persist data found; nothing to migrate.');
    app.quit();
    return;
  }

  // Validate it's the redux-persist blob we expect.
  const parsed = JSON.parse(raw);
  if (!parsed.settings) {
    throw new Error('Legacy persist data does not look like a redux-persist blob');
  }

  const persistDir = path.join(app.getPath('userData'), 'persist');
  fs.mkdirSync(persistDir, { recursive: true });
  const outPath = path.join(persistDir, 'persist_whale-root.json');

  // Merge with any existing new-format file so we don't blindly overwrite.
  let merged = parsed;
  if (fs.existsSync(outPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      merged = { ...existing, ...parsed };
      // eslint-disable-next-line no-console
      console.log('Merged legacy data with existing new-format file.');
    } catch {
      // Existing file is corrupt; just use legacy data.
    }
  }

  fs.writeFileSync(outPath, JSON.stringify(merged), 'utf8');

  const settings = JSON.parse(merged.settings || '{}');
  const locations = JSON.parse(merged.locations || '{}');
  // eslint-disable-next-line no-console
  console.log('Migrated legacy persist data to', outPath);
  // eslint-disable-next-line no-console
  console.log('  themeMode:', settings.themeMode);
  // eslint-disable-next-line no-console
  console.log('  locations:', locations.items?.length ?? 0);

  app.quit();
}

migrate().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Migration failed:', e);
  app.quit();
  process.exit(1);
});
