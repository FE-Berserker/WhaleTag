import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import * as os from 'os';
import { promises as fsp } from 'fs';

import {
  TOOL_DESCRIPTORS,
  READ_TOOLS,
  WRITE_TOOLS,
  parseArguments,
  executeTool,
  type ParsedToolCall,
} from './tools';
import { decideToolCall, type ApprovalResult } from '../claude/approvalHandler';
import { setAllowedRoots } from '../../../allowed-roots';
import { META_DIR } from '../../../../shared/whale-meta';

let tmp: string;

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-http-tools-'));
  setAllowedRoots([tmp]);
});
after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

const call = (name: string, args: string): ParsedToolCall => ({
  id: `tc-${name}`,
  name,
  arguments: args,
});

describe('tools — descriptors', () => {
  it('advertises read_file / list_directory / list_tags / write_file / apply_tag', () => {
    const names = TOOL_DESCRIPTORS.map((t) => t.function.name).sort();
    assert.deepEqual(
      names,
      ['apply_tag', 'list_directory', 'list_tags', 'read_file', 'write_file']
    );
  });

  it('classifies read vs write tools', () => {
    assert.ok(READ_TOOLS.has('read_file'));
    assert.ok(READ_TOOLS.has('list_directory'));
    assert.ok(READ_TOOLS.has('list_tags'));
    assert.ok(WRITE_TOOLS.has('write_file'));
    assert.ok(WRITE_TOOLS.has('apply_tag'));
    assert.ok(!READ_TOOLS.has('write_file'));
    assert.ok(!READ_TOOLS.has('apply_tag'));
    assert.ok(!WRITE_TOOLS.has('list_tags'));
  });
});

describe('parseArguments', () => {
  it('parses valid JSON object args', () => {
    assert.deepEqual(parseArguments('{"path":"/x"}'), { path: '/x' });
  });
  it('returns {} for malformed or non-object input', () => {
    assert.deepEqual(parseArguments('not json'), {});
    assert.deepEqual(parseArguments('[1,2]'), {});
    assert.deepEqual(parseArguments(''), {});
  });
});

describe('executeTool', () => {
  it('reads a file within the allowed root', async () => {
    const p = path.join(tmp, 'a.txt');
    await fsp.writeFile(p, 'hello world');
    const r = await executeTool(call('read_file', JSON.stringify({ path: p })));
    assert.equal(r.isError, false);
    assert.equal(r.content, 'hello world');
  });

  it('lists a directory within the allowed root (dirs suffixed /)', async () => {
    await fsp.mkdir(path.join(tmp, 'sub'));
    await fsp.writeFile(path.join(tmp, 'f.txt'), 'x');
    const r = await executeTool(
      call('list_directory', JSON.stringify({ path: tmp }))
    );
    assert.equal(r.isError, false);
    assert.match(r.content, /sub\//);
    assert.match(r.content, /f\.txt/);
  });

  it('writes a file within the allowed root', async () => {
    const p = path.join(tmp, 'w.txt');
    const r = await executeTool(
      call('write_file', JSON.stringify({ path: p, content: 'WHALE' }))
    );
    assert.equal(r.isError, false);
    assert.equal(await fsp.readFile(p, 'utf8'), 'WHALE');
  });

  it('REFUSES a path outside the allowed root', async () => {
    const outside = path.join(os.tmpdir(), `whale-outside-${process.pid}.txt`);
    const r = await executeTool(
      call('read_file', JSON.stringify({ path: outside }))
    );
    assert.equal(r.isError, true);
    assert.match(r.content, /refused|allowed/i);
  });

  it('returns an error for an unknown tool', async () => {
    const r = await executeTool(call('bogus', '{}'));
    assert.equal(r.isError, true);
    assert.match(r.content, /unknown tool/);
  });
});

describe('executeTool — list_tags', () => {
  it('returns empty tagsByFile when the directory has no .whale/wsd.json', async () => {
    const sub = path.join(tmp, 'untagged-dir');
    await fsp.mkdir(sub);
    const r = await executeTool(call('list_tags', JSON.stringify({ path: sub })));
    assert.equal(r.isError, false);
    assert.deepEqual(JSON.parse(r.content), { tagsByFile: {}, descriptions: {} });
  });

  it('projects wsd.json to { basename: tags[] }', async () => {
    const sub = path.join(tmp, 'tagged-dir');
    await fsp.mkdir(sub);
    await fsp.mkdir(path.join(sub, '.whale'));
    await fsp.writeFile(
      path.join(sub, '.whale', 'wsd.json'),
      JSON.stringify({
        version: 1,
        files: {
          'a.txt': { tags: ['foo:bar', 'baz:qux'] },
          'b.md': { tags: ['period:20260706-20260720'] },
          'c.log': {}, // no tags → omitted from result
        },
      })
    );
    const r = await executeTool(call('list_tags', JSON.stringify({ path: sub })));
    assert.equal(r.isError, false);
    const out = JSON.parse(r.content) as {
      tagsByFile: Record<string, string[]>;
      descriptions: Record<string, string>;
    };
    assert.deepEqual(out.tagsByFile, {
      'a.txt': ['foo:bar', 'baz:qux'],
      'b.md': ['period:20260706-20260720'],
    });
    // These tags aren't in any wtaglib.json, so no descriptions surface even
    // if the library walk in a later test happens to find one up the chain.
    assert.deepEqual(out.descriptions, {});
  });

  it('inlines descriptions for tags actually in use, walking up to wtaglib.json', async () => {
    // Put wtaglib.json at the location root (tmp), wsd.json in a subdir.
    await fsp.mkdir(path.join(tmp, META_DIR), { recursive: true });
    await fsp.writeFile(
      path.join(tmp, META_DIR, 'wtaglib.json'),
      JSON.stringify({
        version: 1,
        descriptions: {
          'workflow:in-progress': 'Active work',
          'workflow:done': 'Finished', // not used → filtered out
          'urgent-important': 'Top priority',
        },
      })
    );
    const sub = path.join(tmp, 'lib-dir');
    await fsp.mkdir(sub);
    await fsp.mkdir(path.join(sub, META_DIR), { recursive: true });
    await fsp.writeFile(
      path.join(sub, META_DIR, 'wsd.json'),
      JSON.stringify({
        version: 1,
        files: { 'x.txt': { tags: ['workflow:in-progress', 'urgent-important'] } },
      })
    );
    const r = await executeTool(call('list_tags', JSON.stringify({ path: sub })));
    assert.equal(r.isError, false);
    const out = JSON.parse(r.content) as {
      tagsByFile: Record<string, string[]>;
      descriptions: Record<string, string>;
    };
    assert.deepEqual(out.tagsByFile, {
      'x.txt': ['workflow:in-progress', 'urgent-important'],
    });
    assert.deepEqual(out.descriptions, {
      'workflow:in-progress': 'Active work',
      'urgent-important': 'Top priority',
    });
    // `workflow:done` is in the library but unused → must not surface.
    assert.ok(!('workflow:done' in out.descriptions));
  });

  it('accepts a file path and uses its parent directory', async () => {
    const sub = path.join(tmp, 'file-input-dir');
    await fsp.mkdir(sub);
    await fsp.mkdir(path.join(sub, META_DIR), { recursive: true });
    await fsp.writeFile(
      path.join(sub, META_DIR, 'wsd.json'),
      JSON.stringify({
        version: 1,
        files: { 'note.md': { tags: ['idea'] } },
      })
    );
    const filePath = path.join(sub, 'note.md');
    await fsp.writeFile(filePath, 'hello');
    const r = await executeTool(call('list_tags', JSON.stringify({ path: filePath })));
    assert.equal(r.isError, false);
    const out = JSON.parse(r.content) as { tagsByFile: Record<string, string[]> };
    assert.deepEqual(out.tagsByFile, { 'note.md': ['idea'] });
  });

  it('REFUSES a path outside the allowed root', async () => {
    const outside = path.join(os.tmpdir(), `whale-outside-${process.pid}`);
    const r = await executeTool(call('list_tags', JSON.stringify({ path: outside })));
    assert.equal(r.isError, true);
    assert.match(r.content, /refused|allowed/i);
  });

  it('returns an error for a missing path', async () => {
    const r = await executeTool(
      call('list_tags', JSON.stringify({ path: path.join(tmp, 'does-not-exist') }))
    );
    assert.equal(r.isError, true);
    assert.match(r.content, /not found/);
  });
});

describe('executeTool — apply_tag', () => {
  /** Helper: read back a directory's wsd.json as a tagsByFile map. */
  async function readTags(dirPath: string): Promise<Record<string, string[]>> {
    const raw = await fsp.readFile(path.join(dirPath, META_DIR, 'wsd.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      files?: Record<string, { tags?: string[] }>;
    };
    const out: Record<string, string[]> = {};
    for (const [name, meta] of Object.entries(parsed.files ?? {})) {
      out[name] = meta?.tags ?? [];
    }
    return out;
  }

  it('adds a free-text tag to a file with no prior sidecar (creates .whale/)', async () => {
    const sub = path.join(tmp, 'apply-add');
    await fsp.mkdir(sub);
    const filePath = path.join(sub, 'a.txt');
    await fsp.writeFile(filePath, 'hello');
    const r = await executeTool(
      call('apply_tag', JSON.stringify({ path: filePath, tag: 'idea' }))
    );
    assert.equal(r.isError, false);
    assert.match(r.content, /Applied tag "idea"/);
    assert.deepEqual(await readTags(sub), { 'a.txt': ['idea'] });
  });

  it('merges a new tag into an existing tag array (no wipe)', async () => {
    const sub = path.join(tmp, 'apply-merge');
    await fsp.mkdir(sub);
    await fsp.mkdir(path.join(sub, META_DIR), { recursive: true });
    const filePath = path.join(sub, 'a.txt');
    await fsp.writeFile(filePath, 'hello');
    await fsp.writeFile(
      path.join(sub, META_DIR, 'wsd.json'),
      JSON.stringify({
        version: 1,
        files: { 'a.txt': { tags: ['idea'], color: '#ff0000' } },
      })
    );
    const r = await executeTool(
      call('apply_tag', JSON.stringify({ path: filePath, tag: 'wip' }))
    );
    assert.equal(r.isError, false);
    // color must survive the merge.
    const raw = JSON.parse(
      await fsp.readFile(path.join(sub, META_DIR, 'wsd.json'), 'utf8')
    );
    assert.equal(raw.files['a.txt'].color, '#ff0000');
    assert.deepEqual(raw.files['a.txt'].tags, ['idea', 'wip']);
  });

  it('replaces an existing workflow tag with a new one (mutual exclusion)', async () => {
    const sub = path.join(tmp, 'apply-exclusive');
    await fsp.mkdir(sub);
    await fsp.mkdir(path.join(sub, META_DIR), { recursive: true });
    const filePath = path.join(sub, 'a.txt');
    await fsp.writeFile(filePath, 'hi');
    // Workflow tags are stored BARE (no `workflow:` prefix) — `not-started`,
    // not `workflow:not-started`. `isWorkflowTag` keys on the bare value.
    await fsp.writeFile(
      path.join(sub, META_DIR, 'wsd.json'),
      JSON.stringify({
        version: 1,
        files: { 'a.txt': { tags: ['not-started'] } },
      })
    );
    const r = await executeTool(
      call(
        'apply_tag',
        JSON.stringify({ path: filePath, tag: 'in-progress' })
      )
    );
    assert.equal(r.isError, false);
    assert.deepEqual(await readTags(sub), { 'a.txt': ['in-progress'] });
    assert.ok(r.content.includes('not-started'));
  });

  it('accepts a bare period tag (20260706-20260720)', async () => {
    const sub = path.join(tmp, 'apply-period');
    await fsp.mkdir(sub);
    const filePath = path.join(sub, 'plan.md');
    await fsp.writeFile(filePath, 'plan');
    const r = await executeTool(
      call(
        'apply_tag',
        JSON.stringify({ path: filePath, tag: '20260706-20260720' })
      )
    );
    assert.equal(r.isError, false);
    assert.deepEqual(await readTags(sub), { 'plan.md': ['20260706-20260720'] });
  });

  it('rejects period-prefixed input with a helpful message', async () => {
    const sub = path.join(tmp, 'apply-period-prefix');
    await fsp.mkdir(sub);
    const filePath = path.join(sub, 'plan.md');
    await fsp.writeFile(filePath, 'plan');
    const r = await executeTool(
      call(
        'apply_tag',
        JSON.stringify({ path: filePath, tag: 'period:20260706-20260720' })
      )
    );
    assert.equal(r.isError, true);
    assert.match(r.content, /no "period:" prefix/i);
    // The file must NOT have been tagged.
    assert.equal(await fsp.readFile(filePath, 'utf8'), 'plan');
    // No wsd.json should have been created.
    await assert.rejects(
      fsp.readFile(path.join(sub, META_DIR, 'wsd.json')),
      (e: NodeJS.ErrnoException) => e.code === 'ENOENT'
    );
  });

  it('removes a tag that exists', async () => {
    const sub = path.join(tmp, 'apply-remove');
    await fsp.mkdir(sub);
    await fsp.mkdir(path.join(sub, META_DIR), { recursive: true });
    const filePath = path.join(sub, 'a.txt');
    await fsp.writeFile(filePath, 'hi');
    await fsp.writeFile(
      path.join(sub, META_DIR, 'wsd.json'),
      JSON.stringify({
        version: 1,
        files: { 'a.txt': { tags: ['idea', 'wip'] } },
      })
    );
    const r = await executeTool(
      call(
        'apply_tag',
        JSON.stringify({ path: filePath, tag: 'idea', mode: 'remove' })
      )
    );
    assert.equal(r.isError, false);
    assert.match(r.content, /Removed tag "idea"/);
    assert.deepEqual(await readTags(sub), { 'a.txt': ['wip'] });
  });

  it('no-ops on remove when the tag was not present', async () => {
    const sub = path.join(tmp, 'apply-remove-nop');
    await fsp.mkdir(sub);
    await fsp.mkdir(path.join(sub, META_DIR), { recursive: true });
    const filePath = path.join(sub, 'a.txt');
    await fsp.writeFile(filePath, 'hi');
    await fsp.writeFile(
      path.join(sub, META_DIR, 'wsd.json'),
      JSON.stringify({
        version: 1,
        files: { 'a.txt': { tags: ['idea'] } },
      })
    );
    const r = await executeTool(
      call(
        'apply_tag',
        JSON.stringify({ path: filePath, tag: 'wip', mode: 'remove' })
      )
    );
    assert.equal(r.isError, false);
    assert.match(r.content, /No-op/);
    assert.deepEqual(await readTags(sub), { 'a.txt': ['idea'] });
  });

  it('REFUSES a path outside the allowed root', async () => {
    const outside = path.join(os.tmpdir(), `whale-outside-tag-${process.pid}.txt`);
    await fsp.writeFile(outside, 'x');
    const r = await executeTool(
      call('apply_tag', JSON.stringify({ path: outside, tag: 'idea' }))
    );
    assert.equal(r.isError, true);
    assert.match(r.content, /refused|allowed/i);
  });

  it('rejects a directory target', async () => {
    const r = await executeTool(
      call(
        'apply_tag',
        JSON.stringify({ path: tmp, tag: 'idea' })
      )
    );
    assert.equal(r.isError, true);
    assert.match(r.content, /needs a file path/);
  });

  it('rejects an empty tag', async () => {
    const sub = path.join(tmp, 'apply-empty-tag');
    await fsp.mkdir(sub);
    const filePath = path.join(sub, 'a.txt');
    await fsp.writeFile(filePath, 'hi');
    const r = await executeTool(
      call('apply_tag', JSON.stringify({ path: filePath, tag: '   ' }))
    );
    assert.equal(r.isError, true);
    assert.match(r.content, /empty "tag"/);
  });
});

describe('decideToolCall', () => {
  const guardCtx = { readOnlyRoots: [], cwd: tmp };
  const allowCb = async (): Promise<ApprovalResult> => ({ decision: 'allow' });
  const denyCb = async (): Promise<ApprovalResult> => ({ decision: 'deny' });

  it('allows when the approval callback allows', async () => {
    const d = await decideToolCall('read_file', { path: '/x' }, guardCtx, allowCb);
    assert.equal(d.behavior, 'allow');
  });

  it('denies when the approval callback denies', async () => {
    const d = await decideToolCall('write_file', { path: '/x' }, guardCtx, denyCb);
    assert.equal(d.behavior, 'deny');
  });

  it('hard-denies a write to a read-only root before asking the user', async () => {
    let asked = false;
    const roCtx = { readOnlyRoots: [tmp], cwd: tmp };
    const d = await decideToolCall(
      'write_file',
      { path: path.join(tmp, 'x.txt') },
      roCtx,
      async () => {
        asked = true;
        return { decision: 'allow' as const };
      }
    );
    assert.equal(d.behavior, 'deny');
    assert.equal(asked, false); // guard short-circuits, never prompts
    assert.match(d.message, /read-only/);
  });

  it('routes apply_tag through the approval gate (not the READ short-circuit)', async () => {
    // apply_tag is in WRITE_TOOLS → not short-circuited by the HTTP provider.
    // It must reach decideToolCall and honor the approval callback.
    const allowed = await decideToolCall(
      'apply_tag',
      { path: '/x/a.txt', tag: 'idea' },
      guardCtx,
      allowCb
    );
    assert.equal(allowed.behavior, 'allow');

    const denied = await decideToolCall(
      'apply_tag',
      { path: '/x/a.txt', tag: 'idea' },
      guardCtx,
      denyCb
    );
    assert.equal(denied.behavior, 'deny');
  });

  it('hard-denies apply_tag to a read-only root (never prompts)', async () => {
    let asked = false;
    const roCtx = { readOnlyRoots: [tmp], cwd: tmp };
    const d = await decideToolCall(
      'apply_tag',
      { path: path.join(tmp, 'x.txt'), tag: 'idea' },
      roCtx,
      async () => {
        asked = true;
        return { decision: 'allow' as const };
      }
    );
    assert.equal(d.behavior, 'deny');
    assert.equal(asked, false);
    assert.match(d.message, /read-only/);
  });
});
