import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { transformSdkMessage, createTransformState } from './transformSdkMessage';
import type { StreamChunk } from '../../../../../shared/ai-types';

/** Collect every chunk a message yields. */
function chunks(message: SDKMessage): StreamChunk[] {
  return Array.from(transformSdkMessage(message));
}

describe('transformSdkMessage', () => {
  it('emits assistant_message_start + text/thinking/tool_use for an assistant message', () => {
    const message = {
      type: 'assistant',
      uuid: 'a1',
      message: {
        content: [
          { type: 'thinking', thinking: 'hm' },
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'world' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } },
        ],
      },
    } as unknown as SDKMessage;

    const out = chunks(message);
    assert.equal(out[0].type, 'assistant_message_start');
    assert.deepEqual(out[0], { type: 'assistant_message_start', itemId: 'a1' });
    assert.deepEqual(out[1], { type: 'thinking', content: 'hm' });
    assert.deepEqual(out[2], { type: 'text', content: 'hello ' });
    assert.deepEqual(out[3], { type: 'text', content: 'world' });
    assert.deepEqual(out[4], {
      type: 'tool_use',
      id: 't1',
      name: 'Read',
      input: { file_path: '/x' },
    });
  });

  it('emits tool_result for a user message carrying tool_result blocks', () => {
    const message = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [{ type: 'text', text: 'file body' }],
            is_error: false,
          },
        ],
      },
    } as unknown as SDKMessage;

    const out = chunks(message);
    assert.deepEqual(out, [
      { type: 'tool_result', id: 't1', content: 'file body', isError: false },
    ]);
  });

  it('flattens a string tool_result content into a single line', () => {
    const message = {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't2', content: 'raw string', is_error: true },
        ],
      },
    } as unknown as SDKMessage;
    assert.deepEqual(chunks(message), [
      { type: 'tool_result', id: 't2', content: 'raw string', isError: true },
    ]);
  });

  it('emits usage + done for a successful result', () => {
    const message = {
      type: 'result',
      subtype: 'success',
      session_id: 'sess-1',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 0,
      },
    } as unknown as SDKMessage;

    const out = chunks(message);
    assert.equal(out.length, 2);
    assert.equal(out[0].type, 'usage');
    assert.equal((out[0] as { sessionId?: string }).sessionId, 'sess-1');
    const usage = (out[0] as { usage: { contextTokens: number; percentage: number } }).usage;
    // contextTokens = input + output + cacheCreation + cacheRead = 10+20+5+0 = 35
    assert.equal(usage.contextTokens, 35);
    assert.ok(usage.percentage >= 0 && usage.percentage <= 100);
    assert.deepEqual(out[1], { type: 'done' });
  });

  it('emits an error chunk for a failed result', () => {
    const message = {
      type: 'result',
      subtype: 'overloaded',
    } as unknown as SDKMessage;
    const out = chunks(message);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'error');
    assert.match((out[0] as { content: string }).content, /overloaded/);
  });

  it('ignores system/init and unknown message types', () => {
    const init = { type: 'system', subtype: 'init' } as unknown as SDKMessage;
    assert.deepEqual(chunks(init), []);
  });
});

describe('transformSdkMessage (streaming deltas)', () => {
  it('streams assistant text token-by-token via content_block_delta', () => {
    const state = createTransformState();
    const uuid = 'm1';
    const start = {
      type: 'stream_event',
      uuid,
      event: { type: 'message_start' },
    } as unknown as SDKMessage;
    const d1 = {
      type: 'stream_event',
      uuid,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } },
    } as unknown as SDKMessage;
    const d2 = {
      type: 'stream_event',
      uuid,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
    } as unknown as SDKMessage;

    const out = [
      ...transformSdkMessage(start, state),
      ...transformSdkMessage(d1, state),
      ...transformSdkMessage(d2, state),
    ];
    assert.deepEqual(out, [
      { type: 'assistant_message_start', itemId: 'm1' },
      { type: 'text', content: 'hel' },
      { type: 'text', content: 'lo' },
    ]);
  });

  it('assembles a tool_use from content_block_start + input_json_delta + stop', () => {
    const state = createTransformState();
    const uuid = 'm2';
    const blockStart = {
      type: 'stream_event',
      uuid,
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't9', name: 'Write' },
      },
    } as unknown as SDKMessage;
    const json1 = {
      type: 'stream_event',
      uuid,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a' },
      },
    } as unknown as SDKMessage;
    const json2 = {
      type: 'stream_event',
      uuid,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '.txt"}' },
      },
    } as unknown as SDKMessage;
    const stop = {
      type: 'stream_event',
      uuid,
      event: { type: 'content_block_stop', index: 0 },
    } as unknown as SDKMessage;

    const out = [
      ...transformSdkMessage(blockStart, state),
      ...transformSdkMessage(json1, state),
      ...transformSdkMessage(json2, state),
      ...transformSdkMessage(stop, state),
    ];
    assert.deepEqual(out, [
      {
        type: 'tool_use',
        id: 't9',
        name: 'Write',
        input: { file_path: '/a.txt' },
      },
    ]);
  });

  it('dedups the complete assistant message against streamed deltas', () => {
    const state = createTransformState();
    const uuid = 'm3';
    const delta = {
      type: 'stream_event',
      uuid,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
    } as unknown as SDKMessage;
    const complete = {
      type: 'assistant',
      uuid,
      message: {
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } },
        ],
      },
    } as unknown as SDKMessage;
    const toolEmitted = {
      type: 'stream_event',
      uuid,
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 't1', name: 'Read' },
      },
    } as unknown as SDKMessage;
    const toolStop = {
      type: 'stream_event',
      uuid,
      event: { type: 'content_block_stop', index: 1 },
    } as unknown as SDKMessage;

    // Stream the text delta + the tool_use via deltas; the complete message
    // should contribute nothing extra (no duplicate text/tool_use).
    const out = [
      ...transformSdkMessage(
        { type: 'stream_event', uuid, event: { type: 'message_start' } } as unknown as SDKMessage,
        state
      ),
      ...transformSdkMessage(delta, state),
      ...transformSdkMessage(toolEmitted, state),
      ...transformSdkMessage(
        {
          type: 'stream_event',
          uuid,
          event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
        } as unknown as SDKMessage,
        state
      ),
      ...transformSdkMessage(toolStop, state),
      ...transformSdkMessage(complete, state),
    ];
    assert.deepEqual(out, [
      { type: 'assistant_message_start', itemId: 'm3' },
      { type: 'text', content: 'hi' },
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
    ]);
  });

  it('streams thinking via thinking_delta', () => {
    const state = createTransformState();
    const uuid = 'm4';
    const out = transformSdkMessage(
      {
        type: 'stream_event',
        uuid,
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'pondering…' } },
      } as unknown as SDKMessage,
      state
    );
    assert.deepEqual([...out], [{ type: 'thinking', content: 'pondering…' }]);
  });
});

describe('transformSdkMessage (subagents)', () => {
  it('routes a subagent text delta to subagent_text (no top-level bubble)', () => {
    const state = createTransformState();
    const out = [
      ...transformSdkMessage(
        {
          type: 'stream_event',
          uuid: 'sub1',
          parent_tool_use_id: 'taskT',
          event: { type: 'message_start' },
        } as unknown as SDKMessage,
        state
      ),
      ...transformSdkMessage(
        {
          type: 'stream_event',
          uuid: 'sub1',
          parent_tool_use_id: 'taskT',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'working' } },
        } as unknown as SDKMessage,
        state
      ),
    ];
    // message_start for a subagent emits nothing (no top-level bubble).
    assert.deepEqual(out, [
      { type: 'subagent_text', subagentId: 'taskT', content: 'working' },
    ]);
  });

  it('routes a subagent tool_use + tool_result to subagent_* chunks', () => {
    const state = createTransformState();
    const out = [
      ...transformSdkMessage(
        {
          type: 'assistant',
          uuid: 'sub2',
          parent_tool_use_id: 'taskT',
          message: {
            content: [
              { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x' } },
            ],
          },
        } as unknown as SDKMessage,
        state
      ),
      ...transformSdkMessage(
        {
          type: 'user',
          parent_tool_use_id: 'taskT',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tu1', content: 'body', is_error: false },
            ],
          },
        } as unknown as SDKMessage,
        state
      ),
    ];
    assert.deepEqual(out, [
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
    ]);
  });
});
