import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  linkToAbsolute,
  rewriteExcalidrawElementsToAbsolute,
  rewriteExcalidrawJsonToRelative,
} from './excalidraw-links';

// Minimal excalidraw scene shape — only the bits the rewriters touch.
const scene = (link: string) => ({
  type: 'excalidraw',
  version: 2,
  source: 'whale',
  elements: [
    { type: 'rectangle', id: 'r1' }, // no link → untouched
    { type: 'image', id: 'i1', link }, // the link we rewrite
  ],
  appState: {},
  files: {},
});

describe('excalidraw-links.rewriteExcalidrawElementsToAbsolute', () => {
  it('resolves a ./ relative link to an absolute bare path', () => {
    const els = scene('./sub/foo.png').elements;
    rewriteExcalidrawElementsToAbsolute(els, '/docs/d.excalidraw');
    assert.equal((els[1] as { link: string }).link, '/docs/sub/foo.png');
  });

  it('leaves an already-absolute link (old diagram) untouched', () => {
    const els = scene('/docs/old.png').elements;
    rewriteExcalidrawElementsToAbsolute(els, '/docs/d.excalidraw');
    assert.equal((els[1] as { link: string }).link, '/docs/old.png');
  });

  it('leaves an external URL untouched', () => {
    const els = scene('https://example.com/x').elements;
    rewriteExcalidrawElementsToAbsolute(els, '/docs/d.excalidraw');
    assert.equal((els[1] as { link: string }).link, 'https://example.com/x');
  });

  it('handles a Windows backslash diagram path', () => {
    const els = scene('./sub/foo.png').elements;
    rewriteExcalidrawElementsToAbsolute(els, 'C:\\Users\\me\\docs\\d.excalidraw');
    assert.equal(
      (els[1] as { link: string }).link,
      'C:/Users/me/docs/sub/foo.png'
    );
  });

  it('is a no-op when elements is not an array', () => {
    assert.doesNotThrow(() =>
      rewriteExcalidrawElementsToAbsolute(undefined, '/docs/d.excalidraw')
    );
    assert.doesNotThrow(() =>
      rewriteExcalidrawElementsToAbsolute({}, '/docs/d.excalidraw')
    );
  });

  it('does not touch elements without a string link', () => {
    const els: unknown[] = [
      { type: 'image', id: 'i1' }, // no link field
      { type: 'image', id: 'i2', link: 123 }, // non-string link
    ];
    rewriteExcalidrawElementsToAbsolute(els, '/docs/d.excalidraw');
    assert.equal((els[0] as { link?: string }).link, undefined);
    assert.equal((els[1] as { link: unknown }).link, 123);
  });
});

describe('excalidraw-links.rewriteExcalidrawJsonToRelative', () => {
  it('relativizes an inside-dir absolute link to ./…', () => {
    const out = rewriteExcalidrawJsonToRelative(
      JSON.stringify(scene('/docs/sub/foo.png')),
      '/docs/d.excalidraw'
    );
    const parsed = JSON.parse(out);
    assert.equal(parsed.elements[1].link, './sub/foo.png');
  });

  it('leaves an outside-dir absolute link absolute', () => {
    const out = rewriteExcalidrawJsonToRelative(
      JSON.stringify(scene('/other/x.png')),
      '/docs/d.excalidraw'
    );
    const parsed = JSON.parse(out);
    assert.equal(parsed.elements[1].link, '/other/x.png');
  });

  it('leaves an external URL untouched', () => {
    const out = rewriteExcalidrawJsonToRelative(
      JSON.stringify(scene('https://example.com')),
      '/docs/d.excalidraw'
    );
    const parsed = JSON.parse(out);
    assert.equal(parsed.elements[1].link, 'https://example.com');
  });

  it('preserves the rest of the document (appState / files / other elements)', () => {
    const out = rewriteExcalidrawJsonToRelative(
      JSON.stringify(scene('/docs/sub/foo.png')),
      '/docs/d.excalidraw'
    );
    const parsed = JSON.parse(out);
    assert.equal(parsed.type, 'excalidraw');
    assert.equal(parsed.version, 2);
    assert.deepEqual(parsed.appState, {});
    assert.equal(parsed.elements[0].type, 'rectangle');
  });

  it('returns the input unchanged when the JSON is malformed', () => {
    const broken = '{ not valid json';
    assert.equal(
      rewriteExcalidrawJsonToRelative(broken, '/docs/d.excalidraw'),
      broken
    );
  });

  it('round-trips load(abs) ↔ save(rel) stably', () => {
    // save: abs → rel
    const rel = rewriteExcalidrawJsonToRelative(
      JSON.stringify(scene('/docs/sub/deep/foo.png')),
      '/docs/d.excalidraw'
    );
    assert.equal(JSON.parse(rel).elements[1].link, './sub/deep/foo.png');
    // load: rel → abs
    const els = scene('./sub/deep/foo.png').elements;
    rewriteExcalidrawElementsToAbsolute(els, '/docs/d.excalidraw');
    assert.equal((els[1] as { link: string }).link, '/docs/sub/deep/foo.png');
  });
});

// Regression: linkToAbsolute takes the .excalidraw FILE path (not its dir) and
// resolves against the file's DIRECTORY. The click bug was passing the file
// path as the base directly, producing ".../d.excalidraw/sub/foo.png".
describe('excalidraw-links.linkToAbsolute (click-time resolve)', () => {
  it('resolves a relative link against the FILE path (dirname internally)', () => {
    assert.equal(
      linkToAbsolute('./sub/foo.png', '/docs/d.excalidraw'),
      '/docs/sub/foo.png'
    );
  });

  it('does NOT fold the diagram filename into the resolved path', () => {
    const out = linkToAbsolute(
      './000_圆柱齿轮/000_规范/ISO_21771_2_2025.pdf',
      'I:\\Work\\000_机械\\000_齿轮\\齿轮分类.excalidraw'
    );
    assert.equal(
      out,
      'I:/Work/000_机械/000_齿轮/000_圆柱齿轮/000_规范/ISO_21771_2_2025.pdf'
    );
    assert.ok(
      !out.includes('齿轮分类.excalidraw'),
      `resolved path must not contain the diagram filename, got: ${out}`
    );
  });

  it('leaves an already-absolute link unchanged', () => {
    assert.equal(
      linkToAbsolute('/docs/abs.png', '/docs/d.excalidraw'),
      '/docs/abs.png'
    );
  });

  it('leaves an external URL unchanged', () => {
    assert.equal(
      linkToAbsolute('https://example.com', '/docs/d.excalidraw'),
      'https://example.com'
    );
  });
});
