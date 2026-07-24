import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

import { ClaudeChatRuntime } from './ClaudeChatRuntime';
import {
  activeMcpServers,
  buildTurnPrompt,
  buildTurnPromptInput,
} from './buildQueryOptions';
import type {
  AiQueryPayload,
  ManagedMcpServer,
} from '../../../../shared/ai-types';

const baseSettings = {
  provider: 'claude-cli' as const,
  model: 'sonnet',
  permissionMode: 'normal' as const,
  effort: 'high' as const,
  safeMode: 'acceptEdits' as const,
  customSystemPrompt: '',
  envVarOverrides: '',
  cliPath: null,
  loadUserSettings: false,
  ollamaUrl: '',
  openaiUrl: '',
  anthropicBaseUrl: '',
  anthropicAuthMode: 'apiKey' as const,
  mcpServers: [],
  aiHttpTools: true,
};

function opts(over: Partial<Options>): Options {
  return { cwd: '/a', model: 'sonnet', systemPrompt: 'p', ...over } as Options;
}

describe('ClaudeChatRuntime.optionsKey', () => {
  const rt = new ClaudeChatRuntime();

  it('is stable for identical option fields', () => {
    const k1 = rt.optionsKey(opts({ cwd: '/a', resume: 's1' }));
    const k2 = rt.optionsKey(opts({ cwd: '/a', resume: 's1' }));
    assert.equal(k1, k2);
  });

  it('changes when cwd differs (location switch)', () => {
    assert.notEqual(
      rt.optionsKey(opts({ cwd: '/a' })),
      rt.optionsKey(opts({ cwd: '/b' }))
    );
  });

  it('changes when resume (sessionId) differs', () => {
    assert.notEqual(
      rt.optionsKey(opts({ resume: 'sess-1' })),
      rt.optionsKey(opts({ resume: 'sess-2' }))
    );
  });

  it('changes when model or systemPrompt differs', () => {
    assert.notEqual(
      rt.optionsKey(opts({ model: 'sonnet' })),
      rt.optionsKey(opts({ model: 'opus' }))
    );
    assert.notEqual(
      rt.optionsKey(opts({ systemPrompt: 'a' })),
      rt.optionsKey(opts({ systemPrompt: 'b' }))
    );
  });

  it('is order-independent for additionalDirectories', () => {
    assert.equal(
      rt.optionsKey(opts({ additionalDirectories: ['/x', '/y'] })),
      rt.optionsKey(opts({ additionalDirectories: ['/y', '/x'] }))
    );
  });
});

describe('buildTurnPrompt', () => {
  const payload = (over: Partial<AiQueryPayload['turn']>): AiQueryPayload => ({
    conversationId: 'c1',
    cwd: '/a',
    locationRoots: [],
    settings: baseSettings,
    sessionId: null,
    history: [],
    turn: { text: 'hello', ...over },
  });

  it('returns just the text with no attachment', () => {
    assert.equal(buildTurnPrompt(payload({})), 'hello');
  });

  it('wraps an attached file as a current_note block before the text', () => {
    const p = buildTurnPrompt(
      payload({
        currentNotePath: '/a/notes.md',
        editorSelection: { path: '/a/notes.md', text: 'body' },
      })
    );
    assert.match(p, /<current_note path="\/a\/notes\.md">body<\/current_note>/);
    assert.match(p, /hello/);
  });

  it('renders multi-selection as a selected_files envelope before the text', () => {
    const p = buildTurnPrompt(
      payload({
        selectedPaths: ['/a/x.txt', '/a/y.md', '/a/z.log'],
      })
    );
    assert.match(p, /<selected_files count="3">/);
    assert.match(p, /(- | {2}- )\/a\/x\.txt/);
    assert.match(p, /(- | {2}- )\/a\/y\.md/);
    assert.match(p, /(- | {2}- )\/a\/z\.log/);
    assert.match(p, /hello/);
    // Envelope appears before the user text.
    assert.ok(p.indexOf('<selected_files') < p.indexOf('hello'));
  });

  it('omits the selected_files envelope when the list is empty', () => {
    const p = buildTurnPrompt(payload({ selectedPaths: [] }));
    assert.doesNotMatch(p, /selected_files/);
    assert.equal(p, 'hello');
  });
});

describe('activeMcpServers', () => {
  const servers: ManagedMcpServer[] = [
    { name: 'fs', enabled: true, config: { type: 'stdio', command: 'npx', args: ['fs-mcp'] } },
    { name: 'off', enabled: false, config: { type: 'http', url: 'https://x/mcp' } },
    { name: 'git', enabled: true, config: { type: 'stdio', command: 'git-mcp' } },
  ];

  it('keeps only enabled servers, keyed by name', () => {
    const out = activeMcpServers(servers);
    assert.deepEqual(Object.keys(out).sort(), ['fs', 'git']);
    assert.equal((out.off as { url?: string } | undefined), undefined);
  });

  it('projects the config verbatim', () => {
    const out = activeMcpServers(servers);
    assert.deepEqual(out.fs, {
      type: 'stdio',
      command: 'npx',
      args: ['fs-mcp'],
    });
  });

  it('returns an empty object when none are enabled', () => {
    assert.deepEqual(activeMcpServers([]), {});
    assert.deepEqual(
      activeMcpServers([{ name: 'a', enabled: false, config: { type: 'http', url: 'u' } }]),
      {}
    );
  });
});

describe('buildTurnPromptInput', () => {
  const payload = (over: Partial<AiQueryPayload['turn']>): AiQueryPayload => ({
    conversationId: 'c1',
    cwd: '/a',
    locationRoots: [],
    settings: baseSettings,
    sessionId: null,
    history: [],
    turn: { text: 'hello', ...over },
  });

  it('returns a plain string for text-only turns', () => {
    assert.equal(buildTurnPromptInput(payload({})), 'hello');
  });

  it('returns a single-message iterable with image + text blocks when images are present', async () => {
    const input = buildTurnPromptInput(
      payload({
        images: [
          {
            id: 'i1',
            name: 'sel.png',
            mediaType: 'image/png',
            data: 'QUJD',
            size: 3,
            source: 'paste',
          },
        ],
      })
    );
    assert.notEqual(typeof input, 'string');
    const seen: unknown[] = [];
    for await (const m of input as AsyncIterable<unknown>) seen.push(m);
    assert.equal(seen.length, 1);
    const msg = seen[0] as {
      type: string;
      parent_tool_use_id: null;
      message: { role: string; content: unknown[] };
    };
    assert.equal(msg.type, 'user');
    assert.equal(msg.parent_tool_use_id, null);
    assert.equal(msg.message.role, 'user');
    assert.deepEqual(msg.message.content[0], {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
    });
    assert.deepEqual(msg.message.content[1], { type: 'text', text: 'hello' });
  });
});
