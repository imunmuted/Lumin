import test from 'node:test';
import assert from 'node:assert/strict';
import { getLatestModelContext, flattenHistory, extractText } from '../memory/historyContext.js';

test('model context is limited to the latest five stored messages in chronological order', () => {
  const history = Array.from({ length: 9 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: [{ text: `message-${index + 1}` }],
    timestamp: index + 1,
  }));
  const result = getLatestModelContext(history);
  const texts = result.flatMap(item => item.parts.map(part => part.text));
  assert.deepEqual(texts, ['message-5', 'message-6', 'message-7', 'message-8', 'message-9']);
  assert.equal(texts.length, 5);
});

test('history flattening supports the legacy channel-keyed shape', () => {
  const history = {
    channelA: [{ role: 'user', content: [{ text: 'A' }], timestamp: 1 }],
    channelB: [{ role: 'assistant', content: [{ text: 'B' }], timestamp: 2 }],
  };
  assert.deepEqual(flattenHistory(history).map(item => item.timestamp), [1, 2]);
  assert.equal(extractText({ content: 'plain string' }), 'plain string');
});

test('context ignores unknown roles and blank text and always starts with a user turn', () => {
  const result = getLatestModelContext([
    { role: 'system', content: [{ text: 'do not pass this through' }], timestamp: 1 },
    { role: 'assistant', content: [{ text: 'orphaned assistant' }], timestamp: 2 },
    { role: 'user', content: [{ text: 'valid user turn' }], timestamp: 3 },
    { role: 'assistant', content: [{ text: 'valid model turn' }], timestamp: 4 },
    { role: 'user', content: [{ text: '   ' }], timestamp: 5 },
  ]);
  assert.equal(result[0]?.role, 'user');
  assert.equal(result.length, 2);
  assert.deepEqual(result.flatMap(item => item.parts.map(part => part.text)), ['valid user turn', 'valid model turn']);
});

test('requested context limit cannot exceed five messages and remains provider-valid', () => {
  const history = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: [{ text: String(index) }], timestamp: index,
  }));
  const context = getLatestModelContext(history, 100);
  const messages = context.flatMap(item => item.parts);
  assert.ok(messages.length <= 5);
  assert.equal(context[0]?.role, 'user');
});
