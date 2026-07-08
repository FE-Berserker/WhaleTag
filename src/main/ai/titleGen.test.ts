import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  clipTitle,
  generateTitle,
  titleMessages,
  TITLE_MAX,
} from './titleGen';
import type { AiSettingsSnapshot, ChatMessage } from '../../shared/ai-types';

const baseSnapshot = (over: Partial<AiSettingsSnapshot>): AiSettingsSnapshot => ({
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

const msg = (role: 'user' | 'assistant', content: string): ChatMessage => ({
  id: `${role}-${content}`,
  role,
  content,
  timestamp: 0,
});

describe('clipTitle', () => {
  it('trims whitespace and strips surrounding quotes', () => {
    assert.equal(clipTitle('  "Quarterly Report"  '), 'Quarterly Report');
    assert.equal(clipTitle('`Plan`'), 'Plan');
  });

  it('takes only the first line', () => {
    assert.equal(clipTitle('First\nSecond'), 'First');
  });

  it('clips long titles with an ellipsis', () => {
    const long = 'x'.repeat(TITLE_MAX + 20);
    const out = clipTitle(long);
    assert.ok(out.endsWith('…'));
    assert.equal(out.length, TITLE_MAX + 1);
  });

  it('returns empty for blank input', () => {
    assert.equal(clipTitle('   \n  '), '');
  });
});

describe('titleMessages', () => {
  it('starts with a strict system instruction and a transcript user turn', () => {
    const msgs = titleMessages([msg('user', 'hi'), msg('assistant', 'hello')]);
    assert.equal(msgs[0].role, 'system');
    assert.match(msgs[0].content, /ONLY the title/);
    assert.equal(msgs[1].role, 'user');
    assert.match(msgs[1].content, /user: hi/);
    assert.match(msgs[1].content, /assistant: hello/);
  });

  it('handles an empty history', () => {
    const msgs = titleMessages([]);
    assert.match(msgs[1].content, /empty conversation/);
  });
});

describe('generateTitle', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns "" for the Claude CLI provider (skipped)', async () => {
    const title = await generateTitle({
      settings: baseSnapshot({ provider: 'claude-cli' }),
      history: [msg('user', 'hi')],
    });
    assert.equal(title, '');
  });

  it('clips the model reply for HTTP providers', async () => {
    global.fetch = (async () =>
      ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '  "Quarterly earnings plan"  ' } }],
        }),
      } as unknown as Response)) as typeof fetch;

    const title = await generateTitle({
      settings: baseSnapshot({ provider: 'openai' }),
      history: [msg('user', 'summarize the earnings'), msg('assistant', '...')],
    });
    assert.equal(title, 'Quarterly earnings plan');
  });

  it('returns "" on a non-OK response', async () => {
    global.fetch = (async () =>
      ({ ok: false, json: async () => ({}) } as unknown as Response)) as typeof fetch;
    const title = await generateTitle({
      settings: baseSnapshot({ provider: 'ollama' }),
      history: [msg('user', 'hi')],
    });
    assert.equal(title, '');
  });

  it('returns "" when fetch throws', async () => {
    global.fetch = (async () => {
      throw new Error('network');
    }) as typeof fetch;
    const title = await generateTitle({
      settings: baseSnapshot({ provider: 'ollama' }),
      history: [msg('user', 'hi')],
    });
    assert.equal(title, '');
  });
});
