import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, existsSync } from 'fs';
import path from 'path';
import { writeFileWithRevision, backupRevision } from '../src/main/revisions';

/**
 * Simulates the full drawio save path WITHOUT drawio itself: build a fresh
 * drawio-format XML, run the same code path the host uses
 * (`writeFileWithRevision` = `atomicWriteText` + revision backup), and check
 * the file is on disk with the new content.
 *
 * If THIS test passes but drawio's `getXml` still doesn't actually persist,
 * the issue is on the drawio side (export action not emitting autosave,
 * autosave callback not getting through the bridge, etc.) and not in the
 * Whale save IPC chain.
 */
describe('drawio save flow (host IPC chain only, no drawio embed)', () => {
  it('writeFileWithRevision persists a new XML body and backs up the old one', async () => {
    const dir = path.join(__dirname, '..', 'Test', '_save_tmp');
    await fsp.mkdir(dir, { recursive: true });
    try {
      const filePath = path.join(dir, 'SaveMe.drawio');
      // Initial placeholder (same shape as useNewDrawio emits)
      const initial =
        '<mxfile version="22.1.0" type="device">' +
        '<diagram name="Page-1" id="page1">' +
        '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">' +
        '<root><mxCell id="0"/><mxCell id="1" parent="0"/></root>' +
        '</mxGraphModel>' +
        '</diagram>' +
        '</mxfile>';
      await fsp.writeFile(filePath, initial, 'utf8');
      const mtimeBefore = (await fsp.stat(filePath)).mtimeMs;

      // Simulate the user drawing — drawio's `export` would now return a
      // larger XML with shapes in it.
      const modified =
        '<mxfile version="22.1.0" type="device">' +
        '<diagram name="Page-1" id="page1">' +
        '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">' +
        '<root>' +
        '<mxCell id="0"/>' +
        '<mxCell id="1" parent="0"/>' +
        '<mxCell id="2" value="Hello" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>' +
        '</root>' +
        '</mxGraphModel>' +
        '</diagram>' +
        '</mxfile>';

      // The same path the host's `handleSave` runs.
      await backupRevision(filePath);
      const { atomicWriteText } = await import('../src/main/atomic-write');
      await atomicWriteText(filePath, modified);

      // Verify the file is updated.
      const onDisk = await fsp.readFile(filePath, 'utf8');
      assert.equal(onDisk, modified, 'file content matches what was saved');
      const mtimeAfter = (await fsp.stat(filePath)).mtimeMs;
      assert.ok(mtimeAfter > mtimeBefore, 'mtime advances after save');
      assert.ok(onDisk.length > initial.length, 'saved content is larger than placeholder');

      // And the backup made it into revisions/.
      const revDir = path.join(dir, '.whale', 'revisions', 'SaveMe.drawio');
      assert.ok(existsSync(revDir), 'revision directory created');
      const revs = await fsp.readdir(revDir);
      assert.ok(revs.length >= 1, `at least one revision backup, got ${revs.length}`);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
