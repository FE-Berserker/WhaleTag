import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchDrawioMessage } from './drawio-bridge';

describe('drawio-bridge.dispatchDrawioMessage', () => {
  it('returns init for {event:"init"}', () => {
    const r = dispatchDrawioMessage({ event: 'init' });
    assert.deepEqual(r, { kind: 'init' });
  });

  it('returns xml for {event:"autosave", xml}', () => {
    const r = dispatchDrawioMessage({ event: 'autosave', xml: '<mxfile/>' });
    assert.deepEqual(r, { kind: 'xml', xml: '<mxfile/>' });
  });

  it('returns xml for {event:"save", xml}', () => {
    const r = dispatchDrawioMessage({ event: 'save', xml: '<mxfile/>' });
    assert.deepEqual(r, { kind: 'xml', xml: '<mxfile/>' });
  });

  // Regression (2026-06-30): drawio's `action: 'export', format: 'xml'`
  // response is `{event: 'export', xml: '...', format: 'svg'}` (not
  // `autosave`/`save`). Pre-fix the bridge only handled those two, so the
  // save flow's `getXml` queue never resolved and the 5-second timeout
  // fired with "draw.io save timeout". This test locks the `export`
  // branch in.
  it('returns xml for {event:"export", xml} (regression for the save timeout bug)', () => {
    const r = dispatchDrawioMessage({
      event: 'export',
      format: 'svg',
      xml: '<mxfile><diagram name="Page-1"/></mxfile>',
    });
    assert.deepEqual(r, {
      kind: 'xml',
      xml: '<mxfile><diagram name="Page-1"/></mxfile>',
    });
  });

  it('returns null for autosave/save/export without xml (no-op)', () => {
    assert.equal(dispatchDrawioMessage({ event: 'autosave' }), null);
    assert.equal(dispatchDrawioMessage({ event: 'save' }), null);
    assert.equal(dispatchDrawioMessage({ event: 'export' }), null);
  });

  it('returns null for {event:"exit"} and {event:"status",...} (not for the bridge)', () => {
    assert.equal(dispatchDrawioMessage({ event: 'exit' }), null);
    assert.equal(
      dispatchDrawioMessage({ event: 'status', message: 'Saving…' }),
      null
    );
  });

  it('returns error for {event:"error"} or {action:"error"}', () => {
    assert.deepEqual(
      dispatchDrawioMessage({ event: 'error', message: 'boom' }),
      { kind: 'error', message: 'boom' }
    );
    assert.deepEqual(
      dispatchDrawioMessage({ action: 'error', error: 'oops' }),
      { kind: 'error', message: 'oops' }
    );
    // Falls back to a generic message when neither message nor error is set.
    assert.deepEqual(
      dispatchDrawioMessage({ event: 'error' }),
      { kind: 'error', message: 'Draw.io error' }
    );
  });

  // Drawio posts `{event:'openLink', href, target, allowOpener}` when the user
  // clicks a cell with a `<UserObject link="…">` wrapper. The bridge must
  // surface it as an `openLink` kind so the extension can forward to the host
  // (which routes file:// URLs through `openNative` instead of letting the
  // sandboxed iframe navigate).
  it('returns openLink for {event:"openLink", href} with optional target', () => {
    assert.deepEqual(
      dispatchDrawioMessage({
        event: 'openLink',
        href: 'file:///C:/foo/bar.pdf',
      }),
      { kind: 'openLink', href: 'file:///C:/foo/bar.pdf', target: undefined }
    );
    assert.deepEqual(
      dispatchDrawioMessage({
        event: 'openLink',
        href: 'https://draw.io',
        target: '_blank',
      }),
      { kind: 'openLink', href: 'https://draw.io', target: '_blank' }
    );
  });

  // openLink with no href (or a non-string href) is dropped — nothing to open.
  it('returns null for openLink without a usable href', () => {
    assert.equal(dispatchDrawioMessage({ event: 'openLink' }), null);
    assert.equal(dispatchDrawioMessage({ event: 'openLink', href: '' }), null);
    assert.equal(
      dispatchDrawioMessage({ event: 'openLink', href: 123 }),
      null
    );
  });
});
