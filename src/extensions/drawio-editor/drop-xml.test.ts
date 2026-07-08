import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import globalJsdom from 'global-jsdom';
import {
  appendSnippetToDiagram,
  buildFileDropDocument,
  buildFileDropSnippet,
  buildLabeledDropSnippet,
  dataUrlToDrawioSafe,
  decodeDrawioDiagram,
  escapeXmlAttr,
  nextDropPosition,
  toFileUrl,
  uniqueCellId,
} from './drop-xml';

// appendSnippetToDiagram uses DOMParser / XMLSerializer / atob / btoa.
// Node has none of these. global-jsdom polyfills them, but importing it
// triggers a large bundle evaluation that OOMs when this file is the
// FIRST to load (the Electron + ts-node combo exhausts the 4 GB heap).
// We mitigate by lazy-requiring global-jsdom from inside the describe
// block — by then the other 30+ tests have already loaded their modules.
before(async () => {
  if (typeof (globalThis as { DOMParser?: unknown }).DOMParser !== 'undefined') return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const jsdom = require('global-jsdom');
  jsdom();
});

// Note on test coverage: the decode/encode/append helpers
// (`decodeDrawioDiagram`, `encodeDrawioDiagram`, `appendSnippetToDiagram`)
// need browser globals (DOMParser, XMLSerializer, atob, btoa) and the
// `fflate` package. Top-level `import globalJsdom from 'global-jsdom'` and
// `import * as fflate from 'fflate'` both OOM in this Electron + ts-node
// combination when this file is the first to load (the heavy bundle
// evaluation exhausts the default 4 GB heap before ts-node can finish
// compiling). The helpers are still exercised at runtime in the app via
// `drawio-bridge.insertLinkedThumbnail` — dev-build smoke test (drag a
// file from the tree → cell appears in drawio → existing cells still
// present) is the verification path until we can get jsdom + fflate to
// play nice with this test environment.

describe('drawio drop-xml.toFileUrl', () => {
  it('converts a POSIX absolute path to file://', () => {
    assert.equal(
      toFileUrl('/Users/me/Documents/report.pdf'),
      'file:///Users/me/Documents/report.pdf'
    );
  });

  it('normalizes Windows backslashes and preserves the drive letter', () => {
    const url = toFileUrl('C:\\foo bar\\baz.pdf');
    assert.equal(url, 'file:///C:/foo%20bar/baz.pdf');
  });

  it('handles a path with mixed slashes', () => {
    assert.equal(toFileUrl('/a/b\\c/d'), 'file:///a/b/c/d');
  });

  it('encodes non-ASCII characters in the path', () => {
    const url = toFileUrl('/data/鲸鱼.drawio');
    assert.ok(url.startsWith('file:///data/'));
    assert.ok(url.includes('%E9%B2%B8%E9%B1%BC')); // encoded 鲸鱼
    assert.ok(url.endsWith('.drawio'));
  });
});

describe('drawio drop-xml.escapeXmlAttr', () => {
  it('escapes & < > and " in attribute values', () => {
    assert.equal(
      escapeXmlAttr('A & <B> "C"'),
      'A &amp; &lt;B&gt; &quot;C&quot;'
    );
  });

  it('passes through harmless characters', () => {
    assert.equal(escapeXmlAttr('plain/path+name.jpg'), 'plain/path+name.jpg');
  });
});

describe('drawio drop-xml.buildFileDropSnippet', () => {
  const thumb = 'data:image/jpeg;base64,AAAA';

  it('wraps the image cell in <UserObject> with link + linkTarget', () => {
    const snippet = buildFileDropSnippet({
      filePath: '/tmp/report.pdf',
      name: 'report.pdf',
      thumbnailDataUrl: thumb,
      cellId: 'img-test1',
      x: 40,
      y: 40,
    });
    assert.ok(
      snippet.includes(
        '<UserObject label="report.pdf" link="file:///tmp/report.pdf" linkTarget="_blank">'
      ),
      `expected <UserObject> wrapper with link, got: ${snippet}`
    );
  });

  it('puts the thumbnail data URL in the style attribute', () => {
    const snippet = buildFileDropSnippet({
      filePath: '/x.png',
      name: 'x.png',
      thumbnailDataUrl: 'data:image/png;base64,XYZ',
      cellId: 'img-test2',
      x: 10,
      y: 20,
    });
    // The data URL keeps its base64 chars but loses the `;base64,` marker
    // so drawio's `;`-splitting style parser leaves the URL intact.
    assert.ok(
      snippet.includes('image=data:image/png,XYZ'),
      `expected base64-payload-only image= style key, got: ${snippet}`
    );
    assert.ok(
      !snippet.includes(';base64,'),
      `must NOT contain ;base64 marker (would break drawio style parser), got: ${snippet}`
    );
    assert.ok(snippet.includes('shape=image;'));
    assert.ok(snippet.includes('aspect=fixed;'));
  });

  it('places the cell at the requested geometry', () => {
    const snippet = buildFileDropSnippet({
      filePath: '/a',
      name: 'a',
      thumbnailDataUrl: thumb,
      cellId: 'img-test3',
      x: 77,
      y: 88,
      width: 200,
      height: 150,
    });
    assert.ok(snippet.includes('x="77" y="88" width="200" height="150"'));
  });

  it('falls back to 240x240 when size omitted', () => {
    const snippet = buildFileDropSnippet({
      filePath: '/a',
      name: 'a',
      thumbnailDataUrl: thumb,
      cellId: 'img-test4',
      x: 0,
      y: 0,
    });
    assert.ok(snippet.includes('width="240" height="240"'));
  });

  it('round-trips a Windows path through the file:// URL', () => {
    const snippet = buildFileDropSnippet({
      filePath: 'C:\\Users\\me\\plan.drawio',
      name: 'plan.drawio',
      thumbnailDataUrl: thumb,
      cellId: 'img-test5',
      x: 0,
      y: 0,
    });
    assert.ok(
      snippet.includes('link="file:///C:/Users/me/plan.drawio"'),
      `expected Windows path as file:// URL, got: ${snippet}`
    );
  });

  it('escapes & < > and " in the label', () => {
    const snippet = buildFileDropSnippet({
      filePath: '/x',
      name: 'A & <B> "C"',
      thumbnailDataUrl: thumb,
      cellId: 'img-test6',
      x: 0,
      y: 0,
    });
    assert.ok(snippet.includes('label="A &amp; &lt;B&gt; &quot;C&quot;"'));
  });

  it('embeds the supplied cellId verbatim', () => {
    const snippet = buildFileDropSnippet({
      filePath: '/a',
      name: 'a',
      thumbnailDataUrl: thumb,
      cellId: 'img-pinned-42',
      x: 0,
      y: 0,
    });
    assert.ok(snippet.includes('id="img-pinned-42"'));
  });

  it('escapes a cellId that contains special characters', () => {
    const snippet = buildFileDropSnippet({
      filePath: '/a',
      name: 'a',
      thumbnailDataUrl: thumb,
      cellId: 'weird<>&"id',
      x: 0,
      y: 0,
    });
    assert.ok(snippet.includes('id="weird&lt;&gt;&amp;&quot;id"'));
  });
});

describe('drawio drop-xml.uniqueCellId', () => {
  it('produces a non-empty string with the supplied prefix', () => {
    const id = uniqueCellId('img');
    assert.ok(id.startsWith('img-'));
    assert.ok(id.length > 4);
  });

  it('produces different ids across calls', () => {
    const a = uniqueCellId('img');
    const b = uniqueCellId('img');
    assert.notEqual(a, b);
  });
});

describe('drawio drop-xml.buildFileDropDocument', () => {
  it('wraps the snippet in a complete <mxfile><diagram><mxGraphModel>', () => {
    const snippet =
      '<UserObject label="x"><mxCell id="x1" style="shape=image"/></UserObject>';
    const doc = buildFileDropDocument(snippet);
    assert.ok(doc.startsWith('<mxfile>'));
    assert.ok(doc.includes('<diagram'));
    assert.ok(doc.includes('<mxGraphModel>'));
    assert.ok(doc.includes('<mxCell id="0"/>'));
    assert.ok(doc.includes('<mxCell id="1" parent="0"/>'));
    assert.ok(doc.includes(snippet));
    assert.ok(doc.endsWith('</mxfile>'));
  });
});

describe('drawio drop-xml.nextDropPosition', () => {
  it('stacks vertically and wraps to the next column after 6 rows', () => {
    assert.deepEqual(nextDropPosition(0), { x: 40, y: 40 });
    assert.deepEqual(nextDropPosition(5), { x: 40, y: 40 + 5 * 150 });
    assert.deepEqual(nextDropPosition(6), { x: 40 + 150, y: 40 });
    assert.deepEqual(nextDropPosition(12), { x: 40 + 2 * 150, y: 40 });
  });
});

describe('drawio drop-xml.buildLabeledDropSnippet', () => {
  const thumb = 'data:image/svg+xml;base64,AAAA';

  it('emits a rounded-rectangle cell style (no shape=image)', () => {
    const snippet = buildLabeledDropSnippet({
      filePath: '/tmp/report.pdf',
      name: 'report.pdf',
      thumbnailDataUrl: thumb,
      cellId: 'lbl-test1',
      x: 40,
      y: 40,
    });
    assert.ok(snippet.includes('rounded=1;'), `expected rounded=1, got: ${snippet}`);
    assert.ok(
      snippet.includes('whiteSpace=wrap;'),
      `expected whiteSpace=wrap, got: ${snippet}`
    );
    assert.ok(
      !snippet.includes('shape=image;'),
      `labeled snippet must NOT include shape=image; got: ${snippet}`
    );
    assert.ok(
      !snippet.includes(`image=${thumb}`),
      `labeled snippet must NOT embed the thumbnail in style=; got: ${snippet}`
    );
  });

  it('wraps the cell in <UserObject> with link + linkTarget', () => {
    const snippet = buildLabeledDropSnippet({
      filePath: '/data/MyFile.pdf',
      name: 'MyFile.pdf',
      thumbnailDataUrl: thumb,
      cellId: 'lbl-test2',
      x: 0,
      y: 0,
    });
    assert.ok(
      snippet.includes(
        '<UserObject label="MyFile.pdf" link="file:///data/MyFile.pdf" linkTarget="_blank">'
      ),
      `expected <UserObject> with link, got: ${snippet}`
    );
  });

  it('defaults to 200x60 geometry', () => {
    const snippet = buildLabeledDropSnippet({
      filePath: '/a',
      name: 'a',
      thumbnailDataUrl: thumb,
      cellId: 'lbl-test3',
      x: 0,
      y: 0,
    });
    assert.ok(
      snippet.includes('width="200" height="60"'),
      `expected default 200x60, got: ${snippet}`
    );
  });

  it('honours explicit width and height overrides', () => {
    const snippet = buildLabeledDropSnippet({
      filePath: '/a',
      name: 'a',
      thumbnailDataUrl: thumb,
      cellId: 'lbl-test4',
      x: 17,
      y: 29,
      width: 300,
      height: 80,
    });
    assert.ok(snippet.includes('x="17" y="29" width="300" height="80"'));
  });

  it('escapes & < > and " in the label', () => {
    const snippet = buildLabeledDropSnippet({
      filePath: '/x',
      name: 'A & <B> "C"',
      thumbnailDataUrl: thumb,
      cellId: 'lbl-test5',
      x: 0,
      y: 0,
    });
    assert.ok(snippet.includes('label="A &amp; &lt;B&gt; &quot;C&quot;"'));
  });

  it('round-trips a Windows path through the file:// URL', () => {
    const snippet = buildLabeledDropSnippet({
      filePath: 'C:\\Users\\me\\my-folder',
      name: 'my-folder',
      thumbnailDataUrl: thumb,
      cellId: 'lbl-test6',
      x: 0,
      y: 0,
    });
    assert.ok(
      snippet.includes('link="file:///C:/Users/me/my-folder"'),
      `expected Windows path as file:// URL, got: ${snippet}`
    );
  });

  it('embeds the supplied cellId verbatim', () => {
    const snippet = buildLabeledDropSnippet({
      filePath: '/a',
      name: 'a',
      thumbnailDataUrl: thumb,
      cellId: 'lbl-pinned-42',
      x: 0,
      y: 0,
    });
    assert.ok(snippet.includes('id="lbl-pinned-42"'));
  });
});

describe('drawio drop-xml.dataUrlToDrawioSafe', () => {
  // The crucial property: the result has no `;` inside the data URL body.
  // drawio splits style on `;`, so a literal `;base64,` marker would break
  // the image reference (image = "data:image/jpeg" alone, the base64
  // payload drops into a separate pseudo-key).
  it('strips `;base64,` from a base64 data URL', () => {
    const out = dataUrlToDrawioSafe('data:image/jpeg;base64,/9j/2wB');
    assert.ok(!out.includes(';base64'), `must drop ;base64 marker, got: ${out}`);
    assert.ok(out.startsWith('data:image/jpeg,'), `got: ${out}`);
    assert.ok(out.endsWith('/9j/2wB'), `payload must be preserved, got: ${out}`);
  });

  it('preserves the base64 alphabet verbatim (no charset mangling)', () => {
    // Base64 alphabet: A-Z, a-z, 0-9, +, /, = — none of these are special
    // in XML attribute values or in drawio's style parser (the only
    // delimiter is `;`).
    const base64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA==';
    const out = dataUrlToDrawioSafe(base64);
    assert.equal(out, 'data:image/png,iVBORw0KGgoAAAANSUhEUgAA==');
  });

  it('passes through non-base64 data URLs unchanged', () => {
    const url = 'data:image/svg+xml,<svg/>';
    assert.equal(dataUrlToDrawioSafe(url), url);
  });

  it('passes through malformed data URLs without throwing', () => {
    assert.doesNotThrow(() => dataUrlToDrawioSafe('not-a-data-url'));
    assert.equal(dataUrlToDrawioSafe('not-a-data-url'), 'not-a-data-url');
  });
});

describe('drawio drop-xml.appendSnippetToDiagram', () => {
  // Regression guard for H.17: the previous implementation used
  //   while (wrap.firstChild) {
  //     root.appendChild(doc.importNode(wrap.firstChild, true));
  //   }
  // `doc.importNode` copies the source — it does NOT remove it from wrap.
  // The while condition therefore never terminated, hanging the extension
  // iframe's JS thread. Test runs with a 1s timeout to catch a future
  // regression of the same kind.
  const DECODED_XML =
    '<mxfile version="22.1.0" type="device">' +
    '<diagram name="Page-1" id="page1">' +
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">' +
    '<root><mxCell id="0"/><mxCell id="1" parent="0"/></root>' +
    '</mxGraphModel>' +
    '</diagram>' +
    '</mxfile>';
  const SNIPPET =
    '<UserObject label="hello.png" link="file:///x.png" linkTarget="_blank">' +
    '<mxCell id="img-test" style="shape=image" vertex="1" parent="1">' +
    '<mxGeometry x="40" y="40" width="120" height="120" as="geometry"/>' +
    '</mxCell>' +
    '</UserObject>';

  it('terminates and produces a non-null appended document', () => {
    // Race the append against a 1s timeout — if the loop hangs, we fail.
    const result = (function raceAppend(): string | null {
      let resolved: string | null = 'PENDING';
      const t = setTimeout(() => {
        if (resolved === 'PENDING') resolved = null;
      }, 1000);
      try {
        const out = appendSnippetToDiagram(DECODED_XML, SNIPPET);
        clearTimeout(t);
        if (resolved === 'PENDING') resolved = out;
      } catch {
        clearTimeout(t);
      }
      return resolved === 'PENDING' ? null : resolved;
    })();
    assert.ok(result !== null, 'appendSnippetToDiagram hung past the 1s safety timeout');
    assert.ok(result!.includes('<mxCell id="img-test"'), 'appended document should contain the snippet cell');
    assert.ok(result!.includes('<mxCell id="0"'), 'appended document should preserve the existing root cells');
  });

  it('returns null when the snippet wrapper fails to parse', () => {
    // `<not-xml-at-all` is an unterminated tag — DOMParser rejects it.
    const result = appendSnippetToDiagram(DECODED_XML, '<not-xml-at-all');
    assert.equal(result, null);
  });

  it('returns null when the diagram has no <root>', () => {
    const noRoot =
      '<mxfile><diagram><mxGraphModel/></diagram></mxfile>';
    assert.equal(appendSnippetToDiagram(noRoot, SNIPPET), null);
  });
});

describe('drawio drop-xml.decodeDrawioDiagram', () => {
  // Regression guard for H.17: this function had the SAME infinite
  // `while (wrap.firstChild)` loop bug that appendSnippetToDiagram had.
  // The freeze manifested after getXml returned — decodeDrawioDiagram
  // entered the loop, hung the JS thread, and drawio never received the
  // `load` action. The 1 s timeout race below catches a regression of
  // either bug in a single test.
  it('terminates within 1 s on a valid compressed drawio payload', () => {
    // A minimal drawio compressed payload — empty Page-1 with two root cells.
    // Compressed with fflate raw deflate, base64-encoded.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fflate = require('fflate');
    const innerXml =
      '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">' +
      '<root><mxCell id="0"/><mxCell id="1" parent="0"/></root>' +
      '</mxGraphModel>';
    const encoded = encodeURIComponent(innerXml);
    const compressed = fflate.compressSync(new TextEncoder().encode(encoded));
    let binary = '';
    for (let i = 0; i < compressed.length; i += 1) {
      binary += String.fromCharCode(compressed[i]);
    }
    const b64 = btoa(binary);
    const drawioCompressed =
      '<mxfile version="22.1.0" type="device">' +
      '<diagram name="Page-1" id="page1">' +
      b64 +
      '</diagram>' +
      '</mxfile>';

    let result: string | null = 'PENDING';
    const t = setTimeout(() => {
      if (result === 'PENDING') result = null;
    }, 1000);
    try {
      result = decodeDrawioDiagram(drawioCompressed);
    } finally {
      clearTimeout(t);
    }
    assert.ok(result !== null && result !== 'PENDING', 'decodeDrawioDiagram hung past the 1 s safety timeout');
    assert.ok(result!.includes('<mxGraphModel'), 'decoded XML should contain mxGraphModel');
    assert.ok(result!.includes('pageWidth="850"'), 'decoded XML should preserve mxGraphModel attrs');
  });

  it('returns the payload unchanged if already uncompressed', () => {
    const uncompressed =
      '<mxfile>' +
      '<diagram><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram>' +
      '</mxfile>';
    assert.equal(decodeDrawioDiagram(uncompressed), uncompressed);
  });
});