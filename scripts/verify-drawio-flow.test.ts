import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import path from 'path';
import { renderDrawioToPng } from '../src/main/drawio-thumb';

/**
 * Mirrors what useNewDrawio.create() does today, end-to-end. The placeholder
 * shape is locked by this test: it must be ONE LINE with `<mxGraphModel>` as
 * the immediate child of `<diagram>` (no whitespace), because drawio's
 * `Editor.parseDiagramNode` (app.min.js) takes the text-content branch
 * (Graph.decompress = atob + pako.inflateRaw) whenever the diagram has any
 * non-whitespace text, and the second branch (children) ends up with no
 * `documentElement` if the first child is a text node.
 */
const NEW_PLACEHOLDER = [
  '<mxfile version="22.1.0" type="device">',
  '<diagram name="Page-1" id="page1">',
  '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">',
  '<root><mxCell id="0"/><mxCell id="1" parent="0"/></root>',
  '</mxGraphModel>',
  '</diagram>',
  '</mxfile>',
].join('');

describe('useNewDrawio end-to-end flow', () => {
  it('writes + reads + renders the new XML placeholder without errors', async () => {
    const dir = path.join(__dirname, '..', 'Test', '_e2e_tmp');
    await fsp.mkdir(dir, { recursive: true });
    try {
      const filePath = path.join(dir, 'NewDiagram.drawio');
      // 1. Write
      await fsp.writeFile(filePath, NEW_PLACEHOLDER, 'utf8');
      const onDisk = await fsp.readFile(filePath, 'utf8');
      assert.equal(onDisk, NEW_PLACEHOLDER, 'file written exactly as the placeholder');

      // 2. Render thumbnail directly from the path (the renderer now shows the
      // drawio app icon instead, but the underlying renderer must still work).
      const png = await renderDrawioToPng(filePath);
      assert.ok(png.length > 100, `raw PNG looks non-trivial: ${png.length} bytes`);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('placeholder has the exact shape drawio.parseDiagramNode requires', () => {
    // Sanity-check the contract: between `<diagram ...>` and the next tag
    // there must be zero characters (no whitespace, no text). A single space
    // or newline breaks the second branch — the first child becomes a text
    // node, importNode yields no documentElement, drawio throws.
    const diagramStart = NEW_PLACEHOLDER.indexOf('<diagram');
    const diagramOpenEnd = NEW_PLACEHOLDER.indexOf('>', diagramStart) + 1;
    const nextChar = NEW_PLACEHOLDER[diagramOpenEnd];
    assert.equal(nextChar, '<', 'character right after <diagram...> is `<` (no whitespace)');
  });

  it('useNewDrawio source ships the one-line placeholder, not the legacy base64', async () => {
    const src = await fsp.readFile(
      path.join(__dirname, '..', 'src', 'renderer', 'hooks', 'useNewDrawio.ts'),
      'utf8'
    );
    assert.ok(
      !src.includes('dZHBEoIgEIafhrtCyp6dLno0M6WLHuMyoUtQp6E4TR+9Uy1rdsH3z74sC2RVNx'),
      'legacy base64 placeholder is gone'
    );
    // The placeholder string is built as concatenated string literals (so
    // TSC can split it across lines without breaking the contract). Match
    // the structural markers, not the exact whitespace.
    assert.ok(
      src.includes('<diagram name="Page-1" id="page1">'),
      'new <diagram> marker is in source'
    );
    assert.ok(
      src.includes('<mxGraphModel dx="800" dy="600"'),
      'new <mxGraphModel> marker is in source'
    );
    assert.ok(
      !src.includes('dZHBEoIg'),
      'legacy base64 placeholder is gone'
    );
  });
});
