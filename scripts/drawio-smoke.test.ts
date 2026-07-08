import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { existsSync } from 'fs';
import { renderDrawioToPng } from '../src/main/drawio-thumb';
import { generateThumbnail, loadThumbnail } from '../src/main/thumbnail';

/**
 * Visual smoke test against the real `Test/sample.drawio` checked into the
 * repo. We don't assert pixel content (would be brittle); we just confirm
 * the pipeline produces a non-trivial JPEG for the fixture.
 */
describe('drawio real-world smoke test', () => {
  it('produces a JPEG for Test/sample.drawio', async () => {
    const sample = path.join(__dirname, '..', 'Test', 'sample.drawio');
    if (!existsSync(sample)) {
      // Skip on machines that don't have the test fixture.
      return;
    }
    const png = await renderDrawioToPng(sample);
    // The sample has a single 120x60 vertex; the rendered scene should be
    // larger than a blank canvas (PAD * 2) and well under the RENDER_MAX cap.
    assert.ok(png.length > 200, `raw PNG looks too small: ${png.length} bytes`);

    await generateThumbnail(sample);
    const url = await loadThumbnail(sample);
    assert.ok(url?.startsWith('data:image/jpeg;base64,'), 'pipeline returns JPEG');
    const b64 = url!.split(',')[1];
    // 200-300 bytes of base64 correspond to a non-trivial 256x256 JPEG
    // (the sample scene is small but the resize/encode adds some overhead).
    assert.ok(b64.length > 200, `thumb looks too small: ${b64.length} base64 chars`);
  });
});
