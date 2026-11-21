import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  replaceManifestPlaceholder,
  shouldCopyDrawioAsset,
  configureDrawioOfflineViewer,
  configureDrawioPreConfig,
} = require('./build-extensions.js') as {
  replaceManifestPlaceholder: (
    content: string,
    id: string,
    manifest: Record<string, unknown>
  ) => string;
  shouldCopyDrawioAsset: (relativePath: string) => boolean;
  configureDrawioOfflineViewer: (html: string) => string;
  configureDrawioPreConfig: (source: string) => string;
};

describe('extension manifest injection', () => {
  it('replaces the placeholder with the serialized manifest', () => {
    const manifest = { id: 'text-editor', fileTypes: ['txt'] };
    const result = replaceManifestPlaceholder(
      'before /* MANIFEST_INJECTED_BY_BUILD */ {} after',
      'text-editor',
      manifest
    );

    assert.equal(
      result,
      'before {"id":"text-editor","fileTypes":["txt"]} after'
    );
  });

  it('does not expand dollar replacement sequences in manifest values', () => {
    const manifest = {
      id: 'text-editor',
      description: 'literal $& $` $\' $1',
    };
    const result = replaceManifestPlaceholder(
      'before /* MANIFEST_INJECTED_BY_BUILD */ {} after',
      'text-editor',
      manifest
    );

    assert.equal(result, `before ${JSON.stringify(manifest)} after`);
  });

  it('fails closed when the placeholder is missing', () => {
    assert.throws(
      () =>
        replaceManifestPlaceholder('manifest: {}', 'text-editor', {
          id: 'text-editor',
        }),
      /Extension text-editor: manifest placeholder not found/
    );
  });
});

describe('drawio asset copy filter', () => {
  it('drops desktop dependencies, source maps and unused viewer bundles', () => {
    const excluded = [
      'META-INF',
      'META-INF/maven/plugin.xml',
      'electron.js',
      'electronFilesWorker.js',
      'node_modules',
      'node_modules/commander/index.js',
      'js/app.min.js.map',
      'js/viewer.min.js',
      'workbox-9fe249eb.js',
    ];

    for (const relativePath of excluded) {
      assert.equal(shouldCopyDrawioAsset(relativePath), false, relativePath);
    }
    assert.equal(
      shouldCopyDrawioAsset('node_modules\\commander\\index.js'),
      false
    );
  });

  it('keeps every asset on the editor runtime path', () => {
    const retained = [
      'index.html',
      'open.html',
      'js/app.min.js',
      'js/viewer-static.min.js',
      'js/diagramly/DesktopLibrary.js',
      'js/diagramly/ElectronApp.js',
      'math/jax/output/SVG/fonts/TeX/fontdata.js',
      'stencils/basic.xml',
      'templates/basic.xml',
      'service-worker.js',
      'workbox-f163abaa.js',
    ];

    for (const relativePath of retained) {
      assert.equal(shouldCopyDrawioAsset(relativePath), true, relativePath);
    }
  });

  it('pins HTML viewer and lightbox URLs to the packaged offline asset', () => {
    const html = '<html><head><script>window.APP = true;</script></head></html>';
    const configured = configureDrawioOfflineViewer(html);
    assert.ok(configured.includes("new URL('js/viewer-static.min.js', window.location.href).href"));
    assert.ok(configured.includes('window.VIEWER_URL = window.DRAWIO_VIEWER_URL'));
    assert.ok(configured.indexOf('window.DRAWIO_VIEWER_URL') < configured.indexOf('window.APP'));
    assert.equal(configureDrawioOfflineViewer(configured), configured);
  });

  it('overrides the vendor PreConfig resets with local viewer and lightbox URLs', () => {
    const baseAssignment =
      "window.DRAWIO_BASE_URL = new URL('.', window.location.href).href.replace(/\\/$/, '')";
    const lightboxAssignment =
      "window.DRAWIO_LIGHTBOX_URL = new URL('.', window.location.href).href.replace(/\\/$/, '')";
    const source = 'window.DRAWIO_BASE_URL = null;\nwindow.DRAWIO_VIEWER_URL = null;';
    const configured = configureDrawioPreConfig(source);
    assert.ok(configured.includes(baseAssignment));
    assert.ok(configured.includes("window.DRAWIO_VIEWER_URL = new URL('js/viewer-static.min.js', window.location.href).href"));
    assert.ok(configured.includes('window.VIEWER_URL = window.DRAWIO_VIEWER_URL'));
    assert.ok(configured.includes(lightboxAssignment));
    assert.equal(configureDrawioPreConfig(configured), configured);
    const reordered = configureDrawioPreConfig(
      'window.DRAWIO_VIEWER_URL = null;\nwindow.DRAWIO_BASE_URL = null;'
    );
    assert.ok(reordered.includes(baseAssignment));
    assert.ok(reordered.includes(lightboxAssignment));
    assert.throws(() => configureDrawioPreConfig('window.APP = true;'), /expected offline URL resets/);
  });
});
