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
        id: 'md-editor',
        name: 'Markdown Editor',
        type: 'editor',
        color: '#00BCD4',
        fileTypes: ['md', 'markdown'],
        entryPoint: 'index.html',
        enabled: true,
        isDefault: true,
      },
      {
        id: 'pdf-viewer',
        name: 'PDF Viewer',
        type: 'viewer',
        color: '#F44336',
        fileTypes: ['pdf'],
        entryPoint: 'index.html',
        enabled: true,
        isDefault: true,
      },
      {
        id: 'office-viewer',
        name: 'Office Viewer',
        type: 'viewer',
        color: '#2B579A',
        fileTypes: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp'],
        entryPoint: 'index.html',
        enabled: true,
        isDefault: true,
      },
      {
        id: 'media-player',
        name: 'Media Player',
        type: 'viewer',
        color: '#FF9800',
        fileTypes: [
          'mp4',
          'mov',
          'mkv',
          'webm',
          'm4v',
          'avi',
          '3gp',
          'ogv',
          'wmv',
          'flv',
          'mp3',
        ],
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

  it('includes md-editor for markdown files', () => {
    const exts = getCompatibleExtensions(entry('foo.md'), context());
    assert.equal(exts.length, 1);
    assert.ok(exts.some((m) => m.id === 'md-editor'));
  });

  it('selects md-editor as the default for markdown files', () => {
    const ext = selectExtension(entry('foo.md'), context());
    assert.equal(ext?.id, 'md-editor');
  });

  it('respects user default override for markdown', () => {
    const ext = selectExtension(
      entry('foo.md'),
      context({ userDefaults: { md: 'md-editor' } })
    );
    assert.equal(ext?.id, 'md-editor');
  });

  it('selects pdf-viewer for pdf files', () => {
    const ext = selectExtension(entry('foo.pdf'), context());
    assert.equal(ext?.id, 'pdf-viewer');
  });

  it('selects media-player for media files', () => {
    const video = selectExtension(entry('foo.mp4'), context());
    assert.equal(video?.id, 'media-player');
    const audio = selectExtension(entry('foo.mp3'), context());
    assert.equal(audio?.id, 'media-player');
  });

  // H.25 (video dispatch fix): every video extension in media-player's manifest
  // must dispatch to media-player, not fall through to MediaLightbox / openNative.
  // Locking each extension down so a future manifest edit doesn't silently drop
  // a format out of the rich-player path.
  it('selects media-player for every video extension in the manifest', () => {
    for (const ext of [
      'mp4',
      'mov',
      'mkv',
      'webm',
      'm4v',
      'avi',
      '3gp',
      'ogv',
      'wmv',
      'flv',
    ]) {
      const manifest = selectExtension(entry(`clip.${ext}`), context());
      assert.equal(
        manifest?.id,
        'media-player',
        `expected media-player for .${ext}`
      );
    }
  });

  it('media-player beats openNative when no other extension handles the type', () => {
    // .flv has no other handler in this test registry — the dispatch must still
    // pick media-player rather than returning null and triggering openNative.
    const manifest = selectExtension(entry('clip.flv'), context());
    assert.equal(manifest?.id, 'media-player');
  });

  it('selects office-viewer for Office files', () => {
    const docx = selectExtension(entry('foo.docx'), context());
    assert.equal(docx?.id, 'office-viewer');
    const xlsx = selectExtension(entry('foo.xlsx'), context());
    assert.equal(xlsx?.id, 'office-viewer');
    const pptx = selectExtension(entry('foo.pptx'), context());
    assert.equal(pptx?.id, 'office-viewer');
  });
});
