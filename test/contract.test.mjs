import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent, SCHEMA_VERSION } from '../lib/contract.mjs';

function baseEvent(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    provider: 'claude',
    repo: 'example/project',
    project: 'example-project',
    taskId: 'issue-175',
    issueNumber: 175,
    title: 'Agent delivery dashboard',
    model: 'claude-sonnet-5',
    branch: 'codex/issue-175-agent-dashboard',
    worktree: 'issue-175-claude',
    timestamp: '2026-08-01T12:00:00Z',
    state: 'implementing',
    ...overrides,
  };
}

test('accepts a well-formed event for every non-blocked, non-question state', () => {
  for (const state of ['queued', 'implementing', 'validating', 'waiting_ci', 'awaiting_sol_review', 'completed']) {
    const result = validateEvent(baseEvent({ state }));
    assert.equal(result.ok, true, `expected ${state} to be accepted: ${result.errors}`);
  }
});

test('accepts practical provider model names and bounded task identifiers', () => {
  for (const [model, taskId] of [
    ['qwen2.5-coder:7b', 'ollama:issue-175'],
    ['mistral-medium-3.5[high]', 'bounded-wrapper:issue-175'],
    ['Claude Sonnet 5', 'claude:issue-175'],
  ]) {
    const result = validateEvent(baseEvent({ model, taskId }));
    assert.equal(result.ok, true, `${model}: ${result.errors.join(', ')}`);
  }
});

test('requires a concise title whenever an issue number is present', () => {
  const result = validateEvent(baseEvent({ title: undefined }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('missing_field: title')));
});

test('accepts a blocked event with strict blocker fields', () => {
  const result = validateEvent(
    baseEvent({
      state: 'blocked',
      blocker: { cause: 'CI flaking', owner: 'sol', nextAction: 'rerun pipeline' },
    }),
  );
  assert.equal(result.ok, true, result.errors.join(', '));
});

test('accepts a question event with strict question fields', () => {
  const result = validateEvent(
    baseEvent({
      state: 'question',
      question: { question: 'Which retention window?', requestedAction: 'confirm 24h' },
    }),
  );
  assert.equal(result.ok, true, result.errors.join(', '));
});

test('rejects unknown providers', () => {
  const result = validateEvent(baseEvent({ provider: 'chatgpt' }));
  assert.equal(result.ok, false);
});

test('rejects "unknown" as an input state', () => {
  const result = validateEvent(baseEvent({ state: 'unknown' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('state_unknown_is_derived_only')));
});

test('rejects unknown top-level fields', () => {
  const result = validateEvent(baseEvent({ transcript: 'some content' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('unknown_field: transcript')));
});

test('rejects overlong title', () => {
  const result = validateEvent(baseEvent({ title: 'x'.repeat(500) }));
  assert.equal(result.ok, false);
});

test('rejects malformed timestamps', () => {
  for (const timestamp of ['not-a-date', '2026-08-01', '2026-13-40T99:99:99Z', '']) {
    const result = validateEvent(baseEvent({ timestamp }));
    assert.equal(result.ok, false, `expected ${timestamp} to be rejected`);
  }
});

test('rejects timestamps far in the future', () => {
  const result = validateEvent(baseEvent({ timestamp: '2099-01-01T00:00:00Z' }));
  assert.equal(result.ok, false);
});

test('rejects absolute worktree paths', () => {
  for (const worktree of ['/tmp/project-worker', '/etc/passwd', 'C:\\worktrees\\issue-175']) {
    const result = validateEvent(baseEvent({ worktree }));
    assert.equal(result.ok, false, `expected ${worktree} to be rejected`);
  }
});

test('rejects worktree labels containing traversal or separators', () => {
  for (const worktree of ['../escape', 'a/b', 'a..b/../c']) {
    const result = validateEvent(baseEvent({ worktree }));
    assert.equal(result.ok, false, `expected ${worktree} to be rejected`);
  }
});

test('rejects branch values containing traversal sequences', () => {
  const result = validateEvent(baseEvent({ branch: 'codex/../../etc' }));
  assert.equal(result.ok, false);
});

test('rejects secret-shaped content in title', () => {
  const secretShaped = ['leaked key ', 'sk-', 'a'.repeat(24)].join('');
  const result = validateEvent(baseEvent({ title: secretShaped }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('secret_shaped_content_rejected')));
});

test('rejects a blocker object when state is not blocked', () => {
  const result = validateEvent(
    baseEvent({ state: 'implementing', blocker: { cause: 'x', owner: 'y', nextAction: 'z' } }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('blocker_only_allowed_when_blocked')));
});

test('requires all blocker fields when state is blocked', () => {
  const result = validateEvent(baseEvent({ state: 'blocked', blocker: { cause: 'x' } }));
  assert.equal(result.ok, false);
});

test('rejects unknown keys inside blocker', () => {
  const result = validateEvent(
    baseEvent({
      state: 'blocked',
      blocker: { cause: 'x', owner: 'y', nextAction: 'z', sessionLog: 'dump' },
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('unknown_field: blocker.sessionLog')));
});

test('rejects non-integer or out-of-range issue numbers', () => {
  for (const issueNumber of [-1, 0, 1.5, 'abc', 99_999_999]) {
    const result = validateEvent(baseEvent({ issueNumber }));
    assert.equal(result.ok, false, `expected issueNumber ${issueNumber} to be rejected`);
  }
});

test('rejects control characters (multi-line content) in text fields', () => {
  const result = validateEvent(baseEvent({ title: 'line one\nline two' }));
  assert.equal(result.ok, false);
});

test('rejects wrong schema version', () => {
  const result = validateEvent(baseEvent({ schemaVersion: 2 }));
  assert.equal(result.ok, false);
});
