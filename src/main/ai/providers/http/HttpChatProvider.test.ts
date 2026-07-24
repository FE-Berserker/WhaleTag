import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildMessages, parseSse } from './HttpChatProvider';
import type { AiQueryPayload, ChatMessage } from '../../../../shared/ai-types';

function fromSse(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe('HttpChatProvider.parseSse', () => {
  it('parses data: frames into JSON payloads and stops at [DONE]', async () => {
    const stream = fromSse([
      'data: {"choices":[{"delta":{"content":"hel"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      '',
      'data: [DONE]',
      '',
      ': comment line',
      'data: {"choices":[{"delta":{"content":"ignored-after-done"}}]}',
      '',
    ].join('\n'));
    const out = [];
    for await (const c of parseSse(stream)) out.push(c);
    assert.equal(out.length, 2);
    assert.equal(out[0].choices?.[0]?.delta?.content, 'hel');
    assert.equal(out[1].choices?.[0]?.delta?.content, 'lo');
  });

  it('skips malformed JSON frames', async () => {
    const stream = fromSse(
      'data: {not json}\n\ndata: {"choices":[]}\n\n'
    );
    const out = [];
    for await (const c of parseSse(stream)) out.push(c);
    assert.equal(out.length, 1); // only the valid frame
  });
});

describe('HttpChatProvider.buildMessages', () => {
  const baseSettings = {
    provider: 'ollama' as const,
    model: 'llama3',
    permissionMode: 'normal' as const,
    effort: 'high' as const,
    safeMode: 'acceptEdits' as const,
    customSystemPrompt: '',
    envVarOverrides: '',
    cliPath: null,
    loadUserSettings: false,
    ollamaUrl: 'http://localhost:11434',
    openaiUrl: 'https://api.openai.com/v1',
    anthropicBaseUrl: '',
    anthropicAuthMode: 'apiKey' as const,
    mcpServers: [],
    aiHttpTools: false,
  };

  function payload(history: ChatMessage[], text: string): AiQueryPayload {
    return {
      conversationId: 'c1',
      cwd: '/tmp',
      locationRoots: [{ path: '/tmp', readOnly: false }],
      settings: baseSettings,
      sessionId: null,
      history,
      turn: { text },
    };
  }

  it('places system first, history next, and the new user turn last', () => {
    const history: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'first', timestamp: 0 },
      { id: 'a1', role: 'assistant', content: 'reply', timestamp: 1 },
    ];
    const msgs = buildMessages(payload(history, 'second'));
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[1].content, 'first');
    assert.equal(msgs[2].content, 'reply');
    assert.equal(msgs[3].role, 'user');
    assert.equal(msgs[3].content, 'second');
  });

  it('inlines attached file content into the new user message', () => {
    const msgs = buildMessages({
      conversationId: 'c1',
      cwd: '/tmp',
      locationRoots: [{ path: '/tmp', readOnly: false }],
      settings: baseSettings,
      sessionId: null,
      history: [],
      turn: {
        text: 'summarize',
        currentNotePath: '/tmp/a.txt',
        editorSelection: { path: '/tmp/a.txt', text: 'file body' },
      },
    });
    const last = msgs[msgs.length - 1];
    assert.equal(typeof last.content, 'string');
    const content = last.content as string;
    assert.match(content, /<current_note path="\/tmp\/a\.txt">file body<\/current_note>/);
    assert.match(content, /summarize/);
  });

  it('renders multi-selection as a selected_files envelope in the user message', () => {
    const msgs = buildMessages({
      conversationId: 'c1',
      cwd: '/tmp',
      locationRoots: [{ path: '/tmp', readOnly: false }],
      settings: baseSettings,
      sessionId: null,
      history: [],
      turn: {
        text: 'tag all of these urgent',
        selectedPaths: ['/tmp/a.txt', '/tmp/b.md'],
      },
    });
    const last = msgs[msgs.length - 1];
    assert.equal(typeof last.content, 'string');
    const content = last.content as string;
    assert.match(content, /<selected_files count="2">/);
    assert.match(content, /\/a\/txt|a\.txt/);
    assert.match(content, /tag all of these urgent/);
  });

  it('builds an OpenAI vision content array when the turn carries images', () => {
    const msgs = buildMessages({
      conversationId: 'c1',
      cwd: '/tmp',
      locationRoots: [{ path: '/tmp', readOnly: false }],
      settings: baseSettings,
      sessionId: null,
      history: [],
      turn: {
        text: 'what is in this region?',
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
      },
    });
    const last = msgs[msgs.length - 1];
    assert.ok(Array.isArray(last.content));
    const parts = last.content as Array<Record<string, unknown>>;
    assert.deepEqual(parts[0], {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,QUJD' },
    });
    assert.deepEqual(parts[1], { type: 'text', text: 'what is in this region?' });
  });
});
