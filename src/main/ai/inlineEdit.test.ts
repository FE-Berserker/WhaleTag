import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanReplacement,
  generateInlineEdit,
  generateInlineEditClaude,
  extractAssistantTextFromSdk,
} from './inlineEdit';
import type { AiSettingsSnapshot } from '../../shared/ai-types';

const snapshot = (over: Partial<AiSettingsSnapshot>): AiSettingsSnapshot => ({
  provider: 'ollama',
  model: 'llama3',
  permissionMode: 'normal',
  effort: 'high',
  safeMode: 'acceptEdits',
  customSystemPrompt: '',
  envVarOverrides: '',
  cliPath: null,
  loadUserSettings: false,
  ollamaUrl: 'http://localhost:11434',
  openaiUrl: 'https://api.openai.com/v1',
  anthropicBaseUrl: '',
  anthropicAuthMode: 'apiKey' as const,
  mcpServers: [],
  aiHttpTools: true,
  ...over,
});

describe('cleanReplacement', () => {
  it('strips a single surrounding triple fence (with or without language)', () => {
    assert.equal(cleanReplacement('```js\nconst x = 1\n```'), 'const x = 1');
    assert.equal(cleanReplacement('```\nplain\n```'), 'plain');
  });
  it('leaves non-fenced text unchanged', () => {
    assert.equal(cleanReplacement('just text'), 'just text');
  });
});

describe('generateInlineEdit', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns "" for Claude CLI when no CLI path can be resolved', async () => {
    // Direct call with cliPath=null simulates "no CLI available" — the cold-
    // start branch returns '' without touching the SDK / spawning a process.
    const out = await generateInlineEditClaude(
      {
        settings: snapshot({ provider: 'claude-cli' }),
        selection: 'sel',
        instruction: 'fix',
      },
      /* cliPath */ null
    );
    assert.equal(out, '');
  });

  it('returns the cleaned model reply for HTTP providers', async () => {
    global.fetch = (async () =>
      ({
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: '```\nrewritten text\n```' } },
          ],
        }),
      } as unknown as Response)) as typeof fetch;
    const out = await generateInlineEdit({
      settings: snapshot({ provider: 'openai' }),
      selection: 'orig',
      instruction: 'rewrite',
    });
    assert.equal(out, 'rewritten text');
  });

  it('returns "" on a failed request', async () => {
    global.fetch = (async () => ({ ok: false, json: async () => ({}) } as unknown as Response)) as typeof fetch;
    const out = await generateInlineEdit({
      settings: snapshot({ provider: 'ollama' }),
      selection: 'x',
      instruction: 'y',
    });
    assert.equal(out, '');
  });
});

describe('extractAssistantTextFromSdk', () => {
  /** Build an async iterable from a plain array (mimics `query()` output). */
  async function* asyncFrom<T>(items: T[]): AsyncIterable<T> {
    for (const x of items) yield x;
  }

  it('collects text from the final assistant message (last wins)', async () => {
    const out = await extractAssistantTextFromSdk(
      asyncFrom([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } },
        { type: 'user', message: {} },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } },
      ])
    );
    assert.equal(out, 'second');
  });

  it('joins multiple text blocks in one assistant message in order', async () => {
    const out = await extractAssistantTextFromSdk(
      asyncFrom([
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'pre ' },
              { type: 'tool_use', name: 'X', input: {} },
              { type: 'text', text: 'post' },
            ],
          },
        },
      ])
    );
    assert.equal(out, 'pre post');
  });

  it('returns "" when no assistant text was emitted', async () => {
    const out = await extractAssistantTextFromSdk(
      asyncFrom([
        { type: 'user', message: {} },
        { type: 'result', subtype: 'success' },
      ])
    );
    assert.equal(out, '');
  });

  it('ignores non-text content blocks (tool_use, thinking)', async () => {
    const out = await extractAssistantTextFromSdk(
      asyncFrom([
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'hidden' },
              { type: 'tool_use', name: 'X', input: {} },
              { type: 'text', text: 'visible' },
            ],
          },
        },
      ])
    );
    assert.equal(out, 'visible');
  });

  it('returns "" for an empty stream', async () => {
    const out = await extractAssistantTextFromSdk(asyncFrom([]));
    assert.equal(out, '');
  });
});
