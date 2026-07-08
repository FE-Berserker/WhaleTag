import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { accumulate, applyChunk } from './streamAccumulator';
import type { ChatMessage, StreamChunk } from '../../../shared/ai-types';

const userSeed: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'hi', timestamp: 0 },
];

describe('streamAccumulator', () => {
  it('streams text into a single content block and message.content', () => {
    const chunks: StreamChunk[] = [
      { type: 'assistant_message_start', itemId: 'a1' },
      { type: 'text', content: 'hel' },
      { type: 'text', content: 'lo' },
    ];
    const out = accumulate(chunks, userSeed);
    assert.equal(out.length, 2);
    assert.equal(out[1].role, 'assistant');
    assert.equal(out[1].content, 'hello');
    assert.deepEqual(out[1].contentBlocks, [{ type: 'text', content: 'hello' }]);
  });

  it('registers a tool_use then attaches its tool_result', () => {
    const chunks: StreamChunk[] = [
      { type: 'assistant_message_start', itemId: 'a1' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } },
      { type: 'tool_result', id: 't1', content: 'body', isError: false },
    ];
    const out = accumulate(chunks, userSeed);
    const asst = out[1];
    assert.equal(asst.toolCalls?.length, 1);
    assert.equal(asst.toolCalls?.[0].status, 'completed');
    assert.equal(asst.toolCalls?.[0].result, 'body');
    assert.deepEqual(asst.contentBlocks, [{ type: 'tool_use', toolId: 't1' }]);
  });

  it('marks a tool_result error as error status', () => {
    const chunks: StreamChunk[] = [
      { type: 'assistant_message_start', itemId: 'a1' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm' } },
      { type: 'tool_result', id: 't1', content: 'nope', isError: true },
    ];
    const out = accumulate(chunks, userSeed);
    assert.equal(out[1].toolCalls?.[0].status, 'error');
  });

  it('keeps thinking in its own block separate from text', () => {
    const chunks: StreamChunk[] = [
      { type: 'assistant_message_start', itemId: 'a1' },
      { type: 'thinking', content: 'hm' },
      { type: 'text', content: 'answer' },
    ];
    const out = accumulate(chunks, userSeed);
    assert.deepEqual(out[1].contentBlocks, [
      { type: 'thinking', content: 'hm' },
      { type: 'text', content: 'answer' },
    ]);
  });

  it('treats user_message_start / usage / done as no-ops on messages', () => {
    const before = accumulate(
      [{ type: 'assistant_message_start', itemId: 'a1' }, { type: 'text', content: 'x' }],
      userSeed
    );
    const after = applyChunk(before, { type: 'user_message_start', content: 'ignored' });
    const after2 = applyChunk(after, { type: 'done' });
    const after3 = applyChunk(after2, {
      type: 'usage',
      usage: {
        inputTokens: 1,
        contextWindow: 200000,
        contextTokens: 1,
        percentage: 0,
      },
    });
    assert.deepEqual(after3, before);
  });
});

describe('streamAccumulator (subagents)', () => {
  const baseSeed: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'do it', timestamp: 0 },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: [
        { id: 'taskT', name: 'Task', input: { description: 'sub' }, status: 'running' },
      ],
      contentBlocks: [{ type: 'tool_use', toolId: 'taskT' }],
    },
  ];

  it('nests subagent text + tool calls under the parent tool call', () => {
    const chunks: StreamChunk[] = [
      { type: 'subagent_text', subagentId: 'taskT', content: 'think' },
      {
        type: 'subagent_tool_use',
        subagentId: 'taskT',
        id: 'tu1',
        name: 'Read',
        input: { file_path: '/x' },
      },
      {
        type: 'subagent_tool_result',
        subagentId: 'taskT',
        id: 'tu1',
        content: 'body',
        isError: false,
      },
    ];
    const out = accumulate(chunks, baseSeed);
    const task = out[1].toolCalls?.find((t) => t.id === 'taskT');
    assert.equal(task?.subagent?.output, 'think');
    assert.equal(task?.subagent?.toolCalls.length, 1);
    assert.equal(task?.subagent?.toolCalls[0].status, 'completed');
    assert.equal(task?.subagent?.toolCalls[0].result, 'body');
  });

  it('marks the subagent completed when the parent tool_result arrives', () => {
    const chunks: StreamChunk[] = [
      { type: 'subagent_text', subagentId: 'taskT', content: 'hi' },
      { type: 'tool_result', id: 'taskT', content: 'done', isError: false },
    ];
    const out = accumulate(chunks, baseSeed);
    const task = out[1].toolCalls?.find((t) => t.id === 'taskT');
    assert.equal(task?.status, 'completed');
    assert.equal(task?.subagent?.status, 'completed');
  });

  it('ignores subagent chunks whose parent is unknown (no crash)', () => {
    const out = applyChunk(baseSeed, {
      type: 'subagent_text',
      subagentId: 'missing',
      content: 'orphan',
    });
    assert.deepEqual(out, baseSeed);
  });
});
