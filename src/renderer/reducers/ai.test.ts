import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import aiReducer, {
  initialState,
  newConversation,
  openConversation,
  closeTab,
  setActiveConversation,
  setConversationMessages,
  setConversationMeta,
  deleteConversation,
  rewindConversation,
  MAX_CONVERSATIONS,
} from './ai';
import type { ChatMessage } from '../../shared/ai-types';

const userMsg = (text: string): ChatMessage => ({
  id: `u-${text}`,
  role: 'user',
  content: text,
  timestamp: 1,
});

describe('ai reducer', () => {
  it('NEW_CONVERSATION creates a conversation, opens a tab, and activates it', () => {
    const s = aiReducer(initialState, newConversation('c1'));
    assert.equal(Object.keys(s.conversations).length, 1);
    assert.deepEqual(s.openTabs, ['c1']);
    assert.equal(s.activeId, 'c1');
    assert.equal(s.conversations.c1.sessionId, null);
  });

  it('NEW_CONVERSATION with an existing id surfaces it without duplicating', () => {
    let s = aiReducer(initialState, newConversation('c1'));
    s = aiReducer(s, newConversation('c2'));
    s = aiReducer(s, newConversation('c1'));
    assert.deepEqual(s.openTabs, ['c2', 'c1']);
    assert.equal(s.activeId, 'c1');
    assert.equal(Object.keys(s.conversations).length, 2);
  });

  it('SET_MESSAGES derives a title from the first user message', () => {
    let s = aiReducer(initialState, newConversation('c1'));
    s = aiReducer(
      s,
      setConversationMessages('c1', [userMsg('Summarize quarterly report')])
    );
    assert.equal(s.conversations.c1.messages.length, 1);
    assert.equal(s.conversations.c1.title, 'Summarize quarterly report');
  });

  it('SET_MESSAGES truncates a long title', () => {
    const long = 'x'.repeat(80);
    let s = aiReducer(initialState, newConversation('c1'));
    s = aiReducer(s, setConversationMessages('c1', [userMsg(long)]));
    assert.ok(s.conversations.c1.title.endsWith('…'));
    assert.ok(s.conversations.c1.title.length <= 42);
  });

  it('SET_MESSAGES does not overwrite an already-set title', () => {
    let s = aiReducer(initialState, newConversation('c1'));
    s = aiReducer(s, setConversationMessages('c1', [userMsg('first')]));
    s = aiReducer(
      s,
      setConversationMessages('c1', [userMsg('first'), userMsg('second')])
    );
    assert.equal(s.conversations.c1.title, 'first');
  });

  it('SET_META merges sessionId for resume', () => {
    let s = aiReducer(initialState, newConversation('c1'));
    s = aiReducer(s, setConversationMeta('c1', { sessionId: 'sess-1' }));
    assert.equal(s.conversations.c1.sessionId, 'sess-1');
  });

  it('CLOSE_TAB removes the tab and re-activates a neighbor', () => {
    let s = aiReducer(initialState, newConversation('c1'));
    s = aiReducer(s, newConversation('c2'));
    s = aiReducer(s, newConversation('c3')); // prepend → order [c3,c2,c1], active c3
    s = aiReducer(s, closeTab('c3'));
    assert.deepEqual(s.openTabs, ['c2', 'c1']);
    assert.equal(s.activeId, 'c2');
  });

  it('SET_ACTIVE only switches when the id exists', () => {
    let s = aiReducer(initialState, newConversation('c1'));
    s = aiReducer(s, setActiveConversation('missing'));
    assert.equal(s.activeId, 'c1');
    s = aiReducer(s, setActiveConversation('c1'));
    assert.equal(s.activeId, 'c1');
  });

  it('OPEN_CONVERSATION opens + activates an existing conversation', () => {
    let s = aiReducer(initialState, newConversation('c1'));
    s = aiReducer(s, closeTab('c1'));
    s = aiReducer(s, openConversation('c1'));
    assert.deepEqual(s.openTabs, ['c1']);
    assert.equal(s.activeId, 'c1');
  });

  it('DELETE removes the conversation and its tab', () => {
    let s = aiReducer(initialState, newConversation('c1'));
    s = aiReducer(s, newConversation('c2'));
    s = aiReducer(s, deleteConversation('c1'));
    assert.equal(s.conversations.c1, undefined);
    assert.deepEqual(s.openTabs, ['c2']);
  });

  it('caps total conversations at MAX (oldest closed evicted, open kept)', () => {
    let s = initialState;
    // Create MAX + 5 conversations, closing each — count must stay capped.
    for (let i = 0; i < MAX_CONVERSATIONS + 5; i++) {
      s = aiReducer(s, newConversation(`c${i}`));
      s = aiReducer(s, closeTab(`c${i}`));
    }
    assert.equal(Object.keys(s.conversations).length, MAX_CONVERSATIONS);

    // An OPEN conversation is never chosen for eviction.
    s = aiReducer(s, newConversation('pinned'));
    // 'pinned' is now open + active; create several more closed ones.
    for (let i = 0; i < 5; i++) {
      const id = `more${i}`;
      s = aiReducer(s, newConversation(id));
      s = aiReducer(s, closeTab(id));
    }
    assert.equal(Object.keys(s.conversations).length, MAX_CONVERSATIONS);
    assert.ok(s.conversations.pinned, 'open conversation must not be evicted');
  });
});

describe('ai reducer — rewind', () => {
  const seed = () => {
    let s = aiReducer(initialState, newConversation('c1'));
    const msgs: import('../../shared/ai-types').ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'q1', timestamp: 0 },
      { id: 'a1', role: 'assistant', content: 'r1', timestamp: 1 },
      { id: 'u2', role: 'user', content: 'q2', timestamp: 2 },
      { id: 'a2', role: 'assistant', content: 'r2', timestamp: 3 },
    ];
    s = aiReducer(s, setConversationMessages('c1', msgs));
    s = aiReducer(s, setConversationMeta('c1', { sessionId: 'sess-1' }));
    return s;
  };

  it('drops the message and everything after it', () => {
    const s = aiReducer(seed(), rewindConversation('c1', 'u2'));
    const ids = s.conversations.c1.messages.map((m) => m.id);
    assert.deepEqual(ids, ['u1', 'a1']); // u2 + a2 removed
  });

  it('clears the session id (next turn starts fresh)', () => {
    const s = aiReducer(seed(), rewindConversation('c1', 'a2'));
    assert.equal(s.conversations.c1.sessionId, null);
  });

  it('keeps everything when rewinding the first message (no-op safety)', () => {
    const before = seed();
    const s = aiReducer(before, rewindConversation('c1', 'u1'));
    assert.equal(s.conversations.c1.messages.length, before.conversations.c1.messages.length);
  });

  it('is a no-op for an unknown message id', () => {
    const before = seed();
    const s = aiReducer(before, rewindConversation('c1', 'missing'));
    assert.equal(s, before);
  });
});
