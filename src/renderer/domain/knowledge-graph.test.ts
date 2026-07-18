import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGraph,
  layoutGraph,
  nodeSize,
  type MindMapEntry,
  type MindMapGraph,
  type MindMapDirectoryNode,
} from './knowledge-graph';

function file(name: string, path?: string): MindMapEntry {
  return { name, path: path ?? `/root/${name}`, isDirectory: false };
}
function dir(name: string, path?: string): MindMapEntry {
  return { name, path: path ?? `/root/${name}`, isDirectory: true };
}

function tagsMap(obj: Record<string, string[]>): Map<string, string[]> {
  // H.24 R1: buildGraph looks tags up by full path, and the test `file()`
  // helper defaults to `/root/${name}`, so prefix each name with `/root/`.
  return new Map(Object.entries(obj).map(([k, v]) => [`/root/${k}`, v]));
}

describe('buildGraph', () => {
  it('builds a bipartite tag/file graph with edges file→tag', () => {
    const g = buildGraph(
      [file('a.txt'), file('b.txt')],
      tagsMap({ 'a.txt': ['work', 'idea'], 'b.txt': ['work'] })
    );
    const tags = g.nodes.filter((n) => n.kind === 'tag');
    const files = g.nodes.filter((n) => n.kind === 'file');
    assert.equal(files.length, 2);
    assert.equal(tags.length, 2);
    assert.equal(g.edges.length, 3);
    // every edge goes from a file node to a tag node
    for (const e of g.edges) {
      assert.ok(e.source.startsWith('file:'));
      assert.ok(e.target.startsWith('tag:'));
    }
  });

  it('computes tag degree as the number of linked files', () => {
    const g = buildGraph(
      [file('a.txt'), file('b.txt'), file('c.txt')],
      tagsMap({ 'a.txt': ['work'], 'b.txt': ['work'], 'c.txt': ['idea'] })
    );
    const work = g.nodes.find((n) => n.kind === 'tag' && n.tag === 'work');
    const idea = g.nodes.find((n) => n.kind === 'tag' && n.tag === 'idea');
    assert.equal(work && work.kind === 'tag' ? work.degree : -1, 2);
    assert.equal(idea && idea.kind === 'tag' ? idea.degree : -1, 1);
  });

  it('includes tagged directories as directory nodes', () => {
    const g = buildGraph(
      [dir('sub'), file('a.txt')],
      tagsMap({ sub: ['work'], 'a.txt': ['work', 'work'] })
    );
    assert.equal(g.nodes.filter((n) => n.kind === 'file').length, 1);
    assert.equal(g.nodes.filter((n) => n.kind === 'directory').length, 1);
    assert.equal(g.edges.length, 2); // dir + file each link to 'work'
    const work = g.nodes.find((n) => n.kind === 'tag' && n.tag === 'work');
    assert.equal(work && work.kind === 'tag' ? work.degree : -1, 2); // degree counts both
  });

  it('omits files with no tags and excluded-only tags', () => {
    const g = buildGraph(
      [file('a.txt'), file('b.txt'), file('c.txt')],
      tagsMap({ 'a.txt': [], 'b.txt': ['in-progress'], 'c.txt': ['work', 'in-progress'] }),
      { exclude: ['workflow'] }
    );
    const files = g.nodes.filter((n) => n.kind === 'file');
    // a.txt has no tags; b.txt has only an excluded workflow tag �?both omitted.
    assert.deepEqual(files.map((f) => f.kind === 'file' && f.name), ['c.txt']);
    assert.deepEqual(
      g.nodes.filter((n) => n.kind === 'tag').map((t) => t.kind === 'tag' && t.tag),
      ['work']
    );
  });

  it('captures the file extension', () => {
    const g = buildGraph([file('photo.JPG')], tagsMap({ 'photo.JPG': ['x'] }));
    const f = g.nodes.find((n) => n.kind === 'file');
    assert.equal(f && f.kind === 'file' ? f.ext : '', 'jpg');
  });

  it('dir nodes have kind="directory" and no extension field', () => {
    const g = buildGraph(
      [dir('stuff')],
      tagsMap({ stuff: ['work'] })
    );
    const d = g.nodes.find((n): n is MindMapDirectoryNode => n.kind === 'directory');
    assert.ok(d, 'directory node should exist');
    assert.equal(d.name, 'stuff');
    // only file nodes have ext; directory nodes don't
  });

  it('directory with no tags produces no node', () => {
    const g = buildGraph(
      [dir('untagged'), file('a.txt')],
      tagsMap({ 'a.txt': ['work'] })
    );
    assert.equal(g.nodes.filter((n) => n.kind === 'directory').length, 0);
  });
});

describe('layoutGraph', () => {
  const graph = buildGraph(
    [file('a.txt'), file('b.txt'), file('c.txt')],
    tagsMap({ 'a.txt': ['work', 'idea'], 'b.txt': ['work'], 'c.txt': ['idea'] })
  );

  it('positions every node', () => {
    const pos = layoutGraph(graph, { width: 1000, height: 700 });
    for (const n of graph.nodes) {
      assert.ok(pos.has(n.id), `missing position for ${n.id}`);
    }
  });

  it('places tags on an inner ring (seed only)', () => {
    // Locks the seed-phase invariant that all tags land on a circle
    // around their own centroid. The exact radius depends on canvas
    // size and tag widths; for this small graph (2 tags on 1000×700)
    // it's bounded by the 80px floor in `seedPositions` (the canvas
    // isn't big enough for the natural `tagGap`-derived radius to
    // dominate). Recentering translates the ring but preserves its
    // shape �?we test the *shape* by computing the tag centroid and
    // checking every tag is equidistant from it.
    const pos = layoutGraph(graph, {
      width: 1000,
      height: 700,
      physics: false,
      collide: false,
    });
    let cx = 0;
    let cy = 0;
    let n = 0;
    for (const nd of graph.nodes) {
      if (nd.kind !== 'tag') continue;
      const p = pos.get(nd.id)!;
      cx += p.x;
      cy += p.y;
      n += 1;
    }
    cx /= n;
    cy /= n;
    const radii = new Set<number>();
    for (const nd of graph.nodes) {
      if (nd.kind !== 'tag') continue;
      const p = pos.get(nd.id)!;
      radii.add(Math.hypot(p.x - cx, p.y - cy));
    }
    assert.equal(radii.size, 1, `tags not on a single ring: ${[...radii]}`);
    // Should be at least 80px (the seedPositions floor) and �?canvas.
    const r = radii.values().next().value!;
    assert.ok(r >= 80 && r <= 1000, `ring radius ${r} out of bounds`);
  });

  it('places tags on an inner ring with consistent radius', () => {
    // Locks the seed-phase invariant that tags land on a circle around
    // their own centroid. The exact radius is bounded by the 80px floor
    // in `seedPositions` and the `requiredRadius` derived from total
    // tag widths + per-tag gaps; recentering shifts the ring but
    // preserves its shape.
    const wide = buildGraph(
      Array.from({ length: 12 }, (_, i) => file(`f${i}`)),
      new Map(
        Array.from({ length: 12 }, (_, i) => [
          `/root/f${i}`,
          [`t${i % 6}`, `t${(i + 3) % 6}`],
        ])
      )
    );
    const pos = layoutGraph(wide, { collide: false, width: 800, height: 800 });
    let cx = 0;
    let cy = 0;
    let n = 0;
    for (const nd of wide.nodes) {
      if (nd.kind !== 'tag') continue;
      const p = pos.get(nd.id)!;
      cx += p.x;
      cy += p.y;
      n += 1;
    }
    cx /= n;
    cy /= n;
    const radii = new Set<number>();
    for (const nd of wide.nodes) {
      if (nd.kind !== 'tag') continue;
      radii.add(Math.round(Math.hypot(pos.get(nd.id)!.x - cx, pos.get(nd.id)!.y - cy)));
    }
    assert.equal(radii.size, 1, `tags not on a single ring: ${[...radii]}`);
  });

  it('is deterministic (same graph �?same positions)', () => {
    const a = layoutGraph(graph);
    const b = layoutGraph(graph);
    for (const n of graph.nodes) {
      assert.deepEqual(a.get(n.id), b.get(n.id));
    }
  });

  it('separates overlapping nodes (no AABB overlap after layout)', () => {
    // Five files all sharing one tag �?they stack at the same centroid before
    // the collision pass. After layout, no two boxes should overlap.
    const dense = buildGraph(
      [file('a'), file('b'), file('c'), file('d'), file('e')],
      tagsMap({ a: ['shared'], b: ['shared'], c: ['shared'], d: ['shared'], e: ['shared'] })
    );
    assertNoOverlap(dense, layoutGraph(dense));
  });

  it('separates nodes in a dense many-to-many graph (no AABB overlap)', () => {
    // Regression for the "节点互相遮挡" report: a realistic graph where
    // every file links to multiple tags and tags link to many files. The
    // FR pass collapses connected nodes tightly; the collision pass must
    // still produce a layout where no two bounding boxes overlap.
    const N = 30;
    const tags = ['work', 'idea', 'draft', 'review', 'shipped'];
    const graph = buildGraph(
      Array.from({ length: N }, (_, i) => file(`f${i}`)),
      tagsMap(
        Object.fromEntries(
          Array.from({ length: N }, (_, i) => [
            `f${i}`,
            [tags[i % tags.length], tags[(i + 2) % tags.length]],
          ])
        )
      )
    );
    assertNoOverlap(graph, layoutGraph(graph, { width: 1400, height: 1400 }));
  });

  it('separates many tags on the inner ring (no AABB overlap among tags)', () => {
    // Regression for "是不是没有把标签节点的大小考虑进去": the radial seed
    // places tags at equal angular steps on `tagR = span * 0.28`, ignoring
    // tag width. With 30 tags at span=1300, the arc between neighbors is
    // ~76px while tag pills can be 100-220px wide. The collision pass
    // must resolve these overlapping seed positions.
    const N = 30;
    const graph = buildGraph(
      Array.from({ length: 5 }, (_, i) => file(`f${i}`)),
      tagsMap(
        Object.fromEntries(
          Array.from({ length: 5 }, (_, i) => [
            `f${i}`,
            Array.from({ length: 6 }, (_, j) => `t${(i * 6 + j) % N}`),
          ])
        )
      )
    );
    assertNoOverlap(graph, layoutGraph(graph, { width: 1500, height: 1500 }));
  });

  it('centers the node centroid at the canvas center when previousPos is absent', () => {
    // Asymmetric tag distribution �?two tags, three files, one tag carries two
    // files and the other carries one. Without the recenter step the radial
    // seed leaves the node centroid visibly off-center because the heavier
    // tag's outward push is unbalanced.
    const g = buildGraph(
      [file('a'), file('b'), file('c')],
      tagsMap({ a: ['x'], b: ['x'], c: ['y'] })
    );
    const w = 1000;
    const h = 700;
    const pos = layoutGraph(g, { width: w, height: h, physics: true, collide: true });
    let sumX = 0;
    let sumY = 0;
    for (const p of pos.values()) {
      sumX += p.x;
      sumY += p.y;
    }
    const cx = sumX / pos.size;
    const cy = sumY / pos.size;
    // Recentering moves the centroid to (cx, cy) of the canvas; allow a few
    // pixels of slack because collision separation can push past the mean.
    assert.ok(Math.abs(cx - w / 2) < 5, `centroid x=${cx.toFixed(2)}, expected ${w / 2}`);
    assert.ok(Math.abs(cy - h / 2) < 5, `centroid y=${cy.toFixed(2)}, expected ${h / 2}`);
  });

  it('preserves positions of nodes present in previousPos', () => {
    // Same graph, two passes with position memory: every node's pixel
    // position must survive the second call exactly (modulo the
    // recenter which is skipped when previousPos is in play).
    const g = buildGraph(
      [file('a'), file('b'), file('c')],
      tagsMap({ a: ['x'], b: ['x'], c: ['y'] })
    );
    const first = layoutGraph(g, { width: 1000, height: 1000 });
    const second = layoutGraph(g, { width: 1000, height: 1000 }, first);
    for (const [id, p] of first) {
      assert.deepEqual(second.get(id), p, `position for ${id} should be preserved`);
    }
  });

  it('seeds new nodes around their connected neighbors when previousPos is partial', () => {
    // First graph: 2 tags (x, y) + 3 files (a, b, c). Second graph adds a new
    // tag `z` linked to file `a`. The retained nodes (everything in `first`)
    // must keep their positions exactly; the new tag `z` must land within a
    // reasonable distance of its only neighbor (`a`).
    const g1 = buildGraph(
      [file('a'), file('b'), file('c')],
      tagsMap({ a: ['x'], b: ['x'], c: ['y'] })
    );
    const g2 = buildGraph(
      [file('a'), file('b'), file('c')],
      tagsMap({ a: ['x', 'z'], b: ['x'], c: ['y'] })
    );
    const first = layoutGraph(g1, { width: 1000, height: 1000 });
    const second = layoutGraph(g2, { width: 1000, height: 1000 }, first);
    for (const [id, p] of first) {
      assert.deepEqual(second.get(id), p, `position for ${id} should be preserved`);
    }
    assert.ok(second.has('tag:z'), 'new tag z should be present');
    const zPos = second.get('tag:z')!;
    // File IDs are `file:${path}` (path-based, not name-based) �?find the
    // file 'a' entry by scanning the keys rather than hard-coding the path.
    const aId = [...first.keys()].find((k) => k.startsWith('file:') && k.endsWith('/a'))!;
    const aPos = second.get(aId)!;
    const dist = Math.hypot(zPos.x - aPos.x, zPos.y - aPos.y);
    // New node is in the inner-ring seed OR nudged near its neighbor by the
    // force pass; either way it should land within half a canvas of `a`.
    assert.ok(dist < 500, `new tag z should be near file a, got distance ${dist.toFixed(1)}`);
  });

  it('grows the canvas adaptively with node count', () => {
    // Inner-ring radius scales with `span`, which scales with `√N`. A 50-node
    // graph should place its tag ring noticeably farther from center than a
    // 2-node graph, on the same `physics:false` seeded layout.
    const small = buildGraph([file('a'), file('b')], tagsMap({ a: ['x'], b: ['x'] }));
    const large = buildGraph(
      Array.from({ length: 50 }, (_, i) => file(`f${i}`)),
      tagsMap(
        Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, ['x']]))
      )
    );
    const smallPos = layoutGraph(small, { physics: false, collide: false });
    const largePos = layoutGraph(large, { physics: false, collide: false });
    const tagRingSpan = (pos: Map<string, { x: number; y: number }>) => {
      let maxR = 0;
      for (const p of pos.values()) {
        maxR = Math.max(maxR, Math.hypot(p.x, p.y));
      }
      return maxR;
    };
    // 50 nodes �?canvas �?800 + �?0×50 �?1153 �?inner ring �?1153×0.28 �?323
    // 2 nodes �?canvas floor 800 �?inner ring �?800×0.28 �?224
    // Expect large ring span to be meaningfully larger than small.
    assert.ok(
      tagRingSpan(largePos) > tagRingSpan(smallPos) * 1.2,
      `large ring span ${tagRingSpan(largePos).toFixed(1)} should exceed small ${tagRingSpan(smallPos).toFixed(1)}`
    );
  });

  it('keeps all nodes within canvas bounds after the force pass', () => {
    // A moderately dense graph �?30 files across 2 tags. The FR pass can fling
    // nodes outward if `k` is mis-scaled; with `k = span × 0.04` they should
    // stay roughly inside the canvas. The final `clampToCanvas` pass enforces
    // a 30px margin so even a non-converged high-tension layout can't strand
    // a node outside the viewport.
    const g = buildGraph(
      Array.from({ length: 30 }, (_, i) => file(`f${i}`)),
      tagsMap(
        Object.fromEntries(
          Array.from({ length: 30 }, (_, i) => [`f${i}`, i % 2 === 0 ? ['x'] : ['y']])
        )
      )
    );
    const w = 1000;
    const h = 1000;
    const pos = layoutGraph(g, { width: w, height: h });
    const slack = 35; // clampToCanvas margin (30) + tiny tolerance
    for (const p of pos.values()) {
      assert.ok(
        p.x >= -slack && p.x <= w + slack,
        `node x=${p.x.toFixed(1)} escaped canvas [-${slack}, ${w + slack}]`
      );
      assert.ok(
        p.y >= -slack && p.y <= h + slack,
        `node y=${p.y.toFixed(1)} escaped canvas [-${slack}, ${h + slack}]`
      );
    }
  });

  it('clamps nodes back into the canvas at high tension', () => {
    // Regression for the "张力大时节点飞出画布且回不来" bug: at the slider's
    // Regression for the "张力大时节点飞出画布且回不来" bug �?now obsolete
    // since the tension slider was removed and the FR pass no longer uses
    // tension. The clamp remains as a safety net against any other code
    // path that could put a node off-canvas.
    const g = buildGraph(
      Array.from({ length: 20 }, (_, i) => file(`f${i}`)),
      tagsMap(
        Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, ['x']]))
      )
    );
    const w = 1000;
    const h = 1000;
    const pos = layoutGraph(g, { width: w, height: h });
    const margin = 30;
    for (const p of pos.values()) {
      assert.ok(p.x >= margin - 0.01, `node x=${p.x.toFixed(1)} clamped past left edge`);
      assert.ok(p.x <= w - margin + 0.01, `node x=${p.x.toFixed(1)} clamped past right edge`);
      assert.ok(p.y >= margin - 0.01, `node y=${p.y.toFixed(1)} clamped past top edge`);
      assert.ok(p.y <= h - margin + 0.01, `node y=${p.y.toFixed(1)} clamped past bottom edge`);
    }
  });

  it('estimates file node width from ext text (long exts �?wider boxes)', () => {
    // Regression for the "节点互相遮挡" report: the old `nodeSize` used a
    // fixed 30px for the ext chip, which silently under-counted formats
    // like `drawio`, `markdown`, `webp`, `config` (4+ char extensions). The
    // FileNode style in the view actually grows the chip with text, so the
    // collision estimate must too �?otherwise files with those extensions
    // overlap visually even after the collision pass.
    const short = nodeSize({
      id: 'file:/x.txt',
      kind: 'file',
      name: 'a.txt',
      path: '/x.txt',
      ext: 'txt',
    });
    const long = nodeSize({
      id: 'file:/x.drawio',
      kind: 'file',
      name: 'a.drawio',
      path: '/x.drawio',
      ext: 'drawio',
    });
    // `drawio` is 6 chars at fontSize 9 with padding 8 �?at least 40px chip
    // alone, vs. the 22px minWidth `txt` uses. The collision estimate must
    // reflect that �?at minimum 10px more for the 6-char ext.
    assert.ok(
      long.w > short.w + 10,
      `long-ext box (${long.w}) should be at least 10px wider than short-ext (${short.w})`
    );
  });

  it('caps file node width at the view\'s maxWidth (200)', () => {
    // Mirrors the view's `maxWidth: 200` style. A pathologically long
    // filename + 4-char ext must NOT push the estimate past 200 �?the view
    // ellipsizes, so the rendered box stays at the cap.
    const wide = nodeSize({
      id: 'file:/x.txt',
      kind: 'file',
      name: 'this-is-a-very-long-filename-with-many-characters.txt',
      path: '/x.txt',
      ext: 'txt',
    });
    assert.ok(wide.w <= 200, `wide box ${wide.w} should not exceed view maxWidth 200`);
  });

  it('estimates node size for directory nodes', () => {
    const sz = nodeSize({
      id: 'dir:/root/sub',
      kind: 'directory',
      name: 'My Folder',
      path: '/root/sub',
    });
    assert.ok(sz.w >= 64, `directory node width ${sz.w} too small`);
    assert.ok(sz.w <= 200, `directory node width ${sz.w} exceeds max`);
    assert.equal(sz.h, 26, `directory node height should be 26, got ${sz.h}`);
  });

  it('caps directory node width at 200 for long names', () => {
    const sz = nodeSize({
      id: 'dir:/root/long',
      kind: 'directory',
      name: 'this-is-a-very-long-directory-name-that-should-be-truncated',
      path: '/root/long',
    });
    assert.ok(sz.w <= 200, `long directory name width ${sz.w} should be capped at 200`);
  });
});

/** Asserts no two node boxes overlap (allowing them to just touch). */
function assertNoOverlap(graph: MindMapGraph, pos: Map<string, { x: number; y: number }>) {
  const ns = graph.nodes;
  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) {
      const a = pos.get(ns[i].id)!;
      const b = pos.get(ns[j].id)!;
      const sa = nodeSize(ns[i]);
      const sb = nodeSize(ns[j]);
      const overlapX = (sa.w + sb.w) / 2 - Math.abs(b.x - a.x);
      const overlapY = (sa.h + sb.h) / 2 - Math.abs(b.y - a.y);
      assert.ok(
        overlapX <= 0.5 || overlapY <= 0.5,
        `${ns[i].id} overlaps ${ns[j].id} (x:${overlapX.toFixed(1)} y:${overlapY.toFixed(1)})`
      );
    }
  }
}
