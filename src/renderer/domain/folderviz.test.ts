import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DirEntry } from '../../shared/ipc-types';
import {
  aggregateTree,
  buildTree,
  defaultNodeColor,
  toEChartsSunburst,
  toEChartsTree,
  toEChartsTreemap,
} from './folderviz';

function entry(
  path: string,
  props: Partial<DirEntry> & { isDirectory?: boolean } = {}
): DirEntry {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  return {
    name,
    path,
    isFile: !props.isDirectory,
    isDirectory: !!props.isDirectory,
    size: props.size ?? 0,
    modified: '2026-06-28T10:00:00.000Z',
    extension: ext,
    ...props,
  };
}

describe('buildTree', () => {
  it('builds a simple one-level tree', () => {
    const root = buildTree('/root', [
      entry('/root/a.txt', { size: 10 }),
      entry('/root/b.txt', { size: 20 }),
    ]);
    assert.equal(root.name, 'root');
    assert.equal(root.children?.length, 2);
    assert.ok(root.children?.every((c) => !c.isDirectory));
  });

  it('respects maxDepth and skips deeper entries', () => {
    const root = buildTree('/root', [
      entry('/root/dir1/file.txt', { size: 5 }),
      entry('/root/dir1/sub/file2.txt', { size: 7 }),
    ], { maxDepth: 2 });

    const dir1 = root.children?.find((c) => c.name === 'dir1');
    assert.ok(dir1);
    assert.equal(dir1?.children?.length, 1);
    assert.equal(dir1?.children?.[0].name, 'file.txt');
  });

  it('creates intermediate directory placeholders when only children are listed', () => {
    const root = buildTree('/root', [
      entry('/root/a/b/c.txt', { size: 1 }),
    ], { maxDepth: 3 });

    const a = root.children?.find((c) => c.name === 'a');
    const b = a?.children?.find((c) => c.name === 'b');
    assert.ok(a?.isDirectory);
    assert.ok(b?.isDirectory);
    assert.equal(b?.children?.[0].name, 'c.txt');
  });

  it('merges directory entry with previously created placeholder', () => {
    const root = buildTree('/root', [
      entry('/root/dir/file.txt', { size: 1 }),
      entry('/root/dir', { isDirectory: true }),
    ], { maxDepth: 2 });

    const dir = root.children?.find((c) => c.name === 'dir');
    assert.ok(dir?.isDirectory);
    assert.equal(dir?.children?.length, 1);
  });

  it('ignores entries outside the root', () => {
    const root = buildTree('/root', [
      entry('/other/file.txt', { size: 1 }),
      entry('/root/inside.txt', { size: 2 }),
    ]);
    assert.equal(root.children?.length, 1);
    assert.equal(root.children?.[0].name, 'inside.txt');
  });

  it('drops file entries when filter is "dir" (dirs keep aggregated size)', () => {
    const root = buildTree('/root', [
      entry('/root/a.txt', { size: 10 }),
      entry('/root/b', { isDirectory: true }),
      entry('/root/b/c.txt', { size: 20 }),
    ], { filter: 'dir' });
    // Only the dir survives; the .txt files are gone.
    assert.equal(root.children?.length, 1);
    assert.equal(root.children?.[0].name, 'b');
    assert.ok(root.children?.[0].isDirectory);
    // b's size reflects the sum of all descendant files (c.txt = 20),
    // computed BEFORE files were removed. fileCount is the count of
    // file descendants (1 for c.txt). This is what makes sunburst /
    // treemap show the dir with proportional size under 'dir' mode.
    assert.equal(root.children?.[0].size, 20);
    assert.equal(root.children?.[0].value, 20);
    assert.equal(root.children?.[0].fileCount, 1);
    // b's children: c.txt was filtered out, so b has an empty children
    // array (filter() returns [], not undefined).
    assert.deepEqual(root.children?.[0].children, []);
  });

  it('aggregates first, filters last �?dirs get summed file sizes', () => {
    // Multi-level test: confirms that aggregation happens before
    // filtering, so deeply nested dirs retain their file totals.
    const root = buildTree('/root', [
      entry('/root/a.txt', { size: 10 }),
      entry('/root/sub', { isDirectory: true }),
      entry('/root/sub/b.txt', { size: 20 }),
      entry('/root/sub/c.txt', { size: 30 }),
    ], { filter: 'dir' });
    assert.equal(root.children?.length, 1);
    assert.equal(root.children?.[0].name, 'sub');
    // sub's size = 20 + 30 = 50, kept after files are filtered out.
    assert.equal(root.children?.[0].size, 50);
    assert.equal(root.children?.[0].value, 50);
    // sub's fileCount = 2 (the two .txt files).
    assert.equal(root.children?.[0].fileCount, 2);
  });

  it('drops directory entries when filter is "file"', () => {
    const root = buildTree('/root', [
      entry('/root/a.txt', { size: 10 }),
      entry('/root/b', { isDirectory: true }),
      entry('/root/b/c.txt', { size: 20 }),
    ], { filter: 'file' });
    // Only a.txt survives; the dir b and its children are gone.
    assert.equal(root.children?.length, 1);
    assert.equal(root.children?.[0].name, 'a.txt');
    assert.ok(!root.children?.[0].isDirectory);
  });
});

describe('aggregateTree', () => {
  it('aggregates folder sizes and file counts bottom-up', () => {
    const root = buildTree('/root', [
      entry('/root/dir/a.txt', { size: 10 }),
      entry('/root/dir/b.txt', { size: 20 }),
      entry('/root/dir/sub/c.txt', { size: 30 }),
    ], { maxDepth: 4 });

    const dir = root.children?.find((c) => c.name === 'dir');
    assert.equal(dir?.size, 60);
    assert.equal(dir?.fileCount, 3);
    assert.equal(root.size, 60);
    assert.equal(root.fileCount, 3);
  });

  it('keeps file nodes with their own size and count 1', () => {
    const root = buildTree('/root', [entry('/root/file.txt', { size: 42 })]);
    aggregateTree(root);
    const file = root.children?.[0];
    assert.equal(file?.size, 42);
    assert.equal(file?.fileCount, 1);
  });
});

describe('ECharts data converters', () => {
  const root = buildTree('/root', [
    entry('/root/a.txt', { size: 10 }),
    entry('/root/b.png', { size: 20 }),
  ]);

  it('toEChartsTree preserves hierarchy', () => {
    const data = toEChartsTree(root);
    assert.equal(data.name, 'root');
    assert.equal(data.children.length, 2);
  });

  it('toEChartsTreemap preserves hierarchy', () => {
    const data = toEChartsTreemap(root);
    assert.equal(data.name, 'root');
    assert.equal(data.children.length, 2);
  });

  it('toEChartsSunburst preserves hierarchy', () => {
    const data = toEChartsSunburst(root);
    assert.equal(data.name, 'root');
    assert.equal(data.children.length, 2);
  });

  it('honors custom colorizer', () => {
    const data = toEChartsTree(root, { getColor: () => '#ff0000' });
    assert.equal(data.itemStyle.color, '#ff0000');
  });
});

describe('defaultNodeColor', () => {
  it('colors directories yellow', () => {
    assert.equal(defaultNodeColor({
      name: 'dir', path: '/dir', isDirectory: true, size: 0, value: 0, fileCount: 0,
    }), '#f4b400');
  });

  it('colors images purple', () => {
    assert.equal(defaultNodeColor({
      name: 'x.png', path: '/x.png', isDirectory: false, size: 0, value: 0, fileCount: 1,
    }), '#ba68c8');
  });

  it('falls back to gray for unknown extensions', () => {
    assert.equal(defaultNodeColor({
      name: 'x.abc', path: '/x.abc', isDirectory: false, size: 0, value: 0, fileCount: 1,
    }), '#bdbdbd');
  });
});
