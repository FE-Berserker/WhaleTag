import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
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
