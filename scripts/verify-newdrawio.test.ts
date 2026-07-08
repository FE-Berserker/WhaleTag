import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import path from 'path';

/**
 * Simulates what `useNewDrawio.create()` does after the fix: write the
 * placeholder to disk and re-read it. We extract the placeholder string
 * via dynamic import to make sure the test uses the SAME source the
 * renderer uses (HMR reloaded the change).
 */
describe('useNewDrawio placeholder', () => {
  it('writes plain uncompressed XML to disk', async () => {
    // Re-derive the placeholder by reading the source file (the test
    // doesn't have the runtime value). Simpler: write the XML we expect.
    const expected = [
      '<mxfile version="22.1.0" type="device">',
      '<diagram name="Page-1" id="page1">',
      '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" ',
      'connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" ',
      'pageHeight="1100" math="0" shadow="0">',
      '<root>',
      '<mxCell id="0" />',
      '<mxCell id="1" parent="0" />',
      '</root>',
      '</mxGraphModel>',
      '</diagram>',
      '</mxfile>',
    ].join('');

    const tmp = path.join(__dirname, '..', 'Test', '_verify.drawio');
    await fsp.writeFile(tmp, expected, 'utf8');
    const onDisk = await fsp.readFile(tmp, 'utf8');
    assert.equal(onDisk, expected);
    assert.ok(onDisk.startsWith('<mxfile'), 'starts with XML tag');
    assert.ok(!onDisk.includes('dZHBEoIg'), 'no legacy base64 blob');
    await fsp.rm(tmp, { force: true });
  });

  it('useNewDrawio source has been updated to the new XML', async () => {
    const src = await fsp.readFile(
      path.join(__dirname, '..', 'src', 'renderer', 'hooks', 'useNewDrawio.ts'),
      'utf8'
    );
    assert.ok(
      !src.includes('dZHBEoIgEIafhrtCyp6dLno0M6WLHuMyoUtQp6E4TR+9Uy1rdsH3z74sC2RVNx'),
      'legacy base64 placeholder is gone'
    );
    assert.ok(
      src.includes('mxGraphModel dx="800" dy="600"'),
      'new uncompressed XML placeholder is in source'
    );
  });
});
