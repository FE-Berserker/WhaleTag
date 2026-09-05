import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectExtension,
  getCompatibleExtensions,
  DispatchContext,
} from './extension-dispatch';
import type { ExtensionRegistry } from '../../shared/extension-types';
import type { DirEntry } from '../../shared/ipc-types';

describe('extension dispatch', () => {
  const registry: ExtensionRegistry = {
    extensions: [
      {
        id: 'text-editor',
        name: 'Text Editor',
        type: 'editor',
        color: '#000',
        fileTypes: ['txt', 'log', 'csv', 'tsv', 'json', 'js', 'ts', 'css', 'html', 'xml', 'yaml', 'yml'],
        entryPoint: 'index.html',
        enabled: true,
        isDefault: true,
      },
      {
        id: 'json-viewer',
        name: 'JSON Viewer',
        type: 'viewer',
        color: '#000',
        fileTypes: ['json'],
        entryPoint: 'index.html',
        enabled: true,
        isDefault: true,
      },
      {
        id: 'heic-viewer',
        name: 'HEIC Viewer',
        type: 'viewer',
        color: '#00BCD4',
        fileTypes: ['heic', 'heif'],
        entryPoint: 'index.html',
        enabled: true,
        isDefault: true,
      },
    ],
    generatedAt: new Date().toISOString(),
  };

  const context = (overrides?: Partial<DispatchContext>): DispatchContext => ({
    registry,
    userDefaults: {},
    enabledOverrides: {},
    ...overrides,
  });

  function entry(name: string): DirEntry {
    return {
      name,
      path: `/${name}`,
      isDirectory: false,
      isFile: true,
      size: 0,
      modified: '',
      extension: name.slice(name.lastIndexOf('.') + 1),
    };
  }

  it('selects default extension for file type', () => {
    const ext = selectExtension(entry('foo.txt'), context());
    assert.equal(ext?.id, 'text-editor');
  });

  it('returns null for unsupported file types', () => {
    const ext = selectExtension(entry('foo.exe'), context());
    assert.equal(ext, null);
  });

  it('skips disabled extensions', () => {
    const ext = selectExtension(
      entry('foo.txt'),
      context({ enabledOverrides: { 'text-editor': false } })
    );
    assert.equal(ext, null);
  });

  it('lists compatible extensions for a txt file', () => {
    const exts = getCompatibleExtensions(entry('foo.txt'), context());
    assert.equal(exts.length, 1);
    assert.ok(exts.some((m) => m.id === 'text-editor'));
  });

  it('includes heic-viewer for HEIC files', () => {
    const exts = getCompatibleExtensions(entry('foo.heic'), context());
    assert.equal(exts.length, 1);
    assert.ok(exts.some((m) => m.id === 'heic-viewer'));
  });

  it('selects heic-viewer as the default for HEIC files', () => {
    const ext = selectExtension(entry('foo.heic'), context());
    assert.equal(ext?.id, 'heic-viewer');
  });

  it('respects user default override for heic', () => {
    const ext = selectExtension(
      entry('foo.heic'),
      context({ userDefaults: { heic: 'heic-viewer' } })
    );
    assert.equal(ext?.id, 'heic-viewer');
  });
});
