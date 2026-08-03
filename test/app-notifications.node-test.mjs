import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attentionKey, computeAttentionKeys, selectNewAttentionItems } from '../public/app.js';

function blocker(overrides = {}) {
  return {
    repo: 'example/project',
    taskId: 'issue-1',
    blocker: { cause: 'CI disk full', owner: 'sol', nextAction: 'clear cache' },
    ...overrides,
  };
}

function question(overrides = {}) {
  return {
    repo: 'example/project',
    taskId: 'issue-2',
    question: { question: 'compact density?', requestedAction: 'confirm scope' },
    ...overrides,
  };
}

test('attentionKey distinguishes the same taskId across different repositories', () => {
  const a = attentionKey({ repo: 'org/one', taskId: 'issue-1' }, 'blocker');
  const b = attentionKey({ repo: 'org/two', taskId: 'issue-1' }, 'blocker');
  assert.notEqual(a, b);
});

test('attentionKey distinguishes a blocker from a question on the same task', () => {
  const b = attentionKey({ repo: 'org/one', taskId: 'issue-1' }, 'blocker');
  const q = attentionKey({ repo: 'org/one', taskId: 'issue-1' }, 'question');
  assert.notEqual(b, q);
});

test('attentionKey is stable across changed blocker/question detail text for the same task', () => {
  const first = attentionKey(blocker({ blocker: { cause: 'CI disk full', owner: 'sol', nextAction: 'clear cache' } }), 'blocker');
  const second = attentionKey(blocker({ blocker: { cause: 'CI still full after retry', owner: 'sol', nextAction: 'escalate' } }), 'blocker');
  assert.equal(first, second);
});

test('a blocker present in the previous poll is not reported as new', () => {
  const b = blocker();
  const previous = computeAttentionKeys([b], []);
  const { newBlockers } = selectNewAttentionItems(previous, [b], []);
  assert.deepEqual(newBlockers, []);
});

test('a blocker absent from the previous poll is reported as new', () => {
  const previous = computeAttentionKeys([], []);
  const b = blocker();
  const { newBlockers } = selectNewAttentionItems(previous, [b], []);
  assert.deepEqual(newBlockers, [b]);
});

test('a blocker that resolved and later recurs is reported as new again', () => {
  const b = blocker();
  const previousWhileOpen = computeAttentionKeys([b], []);
  // Resolved: no longer in the live blockers list, so the tracked "seen"
  // set for the *next* poll no longer contains it.
  const previousAfterResolved = computeAttentionKeys([], []);
  const { newBlockers: notNewWhileOpen } = selectNewAttentionItems(previousWhileOpen, [b], []);
  const { newBlockers: newAfterRecurring } = selectNewAttentionItems(previousAfterResolved, [b], []);
  assert.deepEqual(notNewWhileOpen, []);
  assert.deepEqual(newAfterRecurring, [b]);
});

test('questions and blockers are tracked independently of one another', () => {
  const b = blocker();
  const q = question();
  const previous = computeAttentionKeys([b], []);
  const { newBlockers, newQuestions } = selectNewAttentionItems(previous, [b], [q]);
  assert.deepEqual(newBlockers, []);
  assert.deepEqual(newQuestions, [q]);
});

test('computeAttentionKeys produces one key per open blocker and question, none overlapping', () => {
  const keys = computeAttentionKeys([blocker()], [question()]);
  assert.equal(keys.size, 2);
});
