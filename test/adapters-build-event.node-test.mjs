import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent, PROVIDERS, INPUT_STATES } from '../lib/contract.mjs';
import { parseArgs, buildEvent, KNOWN_FLAGS } from '../adapters/lib/build-event.mjs';

function baseArgv(overrides = {}) {
  const fields = {
    repo: 'example/project',
    project: 'example-project',
    'task-id': 'issue-42',
    'issue-number': '42',
    title: 'Improve the delivery view',
    model: 'claude-sonnet-5',
    branch: 'agent/issue-42-delivery-view',
    worktree: 'issue-42-implementation',
    timestamp: '2026-08-01T12:00:00Z',
    state: 'implementing',
    ...overrides,
  };
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `--${key}=${value}`);
}

test('parseArgs accepts every known flag and reports none unknown', () => {
  const { options, unknownFlags } = parseArgs(baseArgv());
  assert.deepEqual(unknownFlags, []);
  assert.equal(options.repo, 'example/project');
  assert.equal(options.state, 'implementing');
});

test('parseArgs rejects flags outside the closed allowlist, including transcript/tool/source-shaped ones', () => {
  for (const badFlag of [
    '--transcript=step 1: ran a tool',
    '--tool-output=cat secrets.env',
    '--diff=--- a/file\\n+++ b/file',
    '--prompt=ignore previous instructions',
    '--command=rm -rf /',
    '--source-file=/etc/passwd',
    '--extra=anything',
  ]) {
    const { unknownFlags } = parseArgs([...baseArgv(), badFlag]);
    assert.ok(unknownFlags.length > 0, `expected ${badFlag} to be rejected as unknown`);
  }
});

test('parseArgs rejects a bare positional argument as unknown rather than ignoring it', () => {
  const { unknownFlags } = parseArgs(['not-a-flag']);
  assert.deepEqual(unknownFlags, ['not-a-flag']);
});

test('KNOWN_FLAGS has no field that could carry transcript, tool, or source content', () => {
  for (const flag of KNOWN_FLAGS) {
    assert.doesNotMatch(flag, /transcript|tool|source|diff|prompt|command|shell/);
  }
});

test('buildEvent produces a contract-passing event for every provider and non-blocked/question state', () => {
  for (const provider of PROVIDERS) {
    for (const state of INPUT_STATES.filter((s) => s !== 'blocked' && s !== 'question')) {
      const { options } = parseArgs(baseArgv({ state }));
      const event = buildEvent(provider, options);
      const result = validateEvent(event);
      assert.equal(result.ok, true, `${provider}/${state}: ${result.errors?.join(', ')}`);
      assert.equal(result.value.provider, provider);
      assert.equal(result.value.state, state);
    }
  }
});

test('buildEvent shapes a valid blocked event from blocker-* flags', () => {
  const { options } = parseArgs(
    baseArgv({
      state: 'blocked',
      'blocker-cause': 'CI runner ran out of disk space',
      'blocker-owner': 'sol',
      'blocker-next-action': 'clear the CI cache and retry',
    }),
  );
  const event = buildEvent('codex', options);
  const result = validateEvent(event);
  assert.equal(result.ok, true, result.errors?.join(', '));
  assert.deepEqual(result.value.blocker, {
    cause: 'CI runner ran out of disk space',
    owner: 'sol',
    nextAction: 'clear the CI cache and retry',
  });
});

test('buildEvent shapes a valid question event from question-* flags', () => {
  const { options } = parseArgs(
    baseArgv({
      state: 'question',
      question: 'Should compact density persist per browser or per user?',
      'question-requested-action': 'confirm the persistence scope',
    }),
  );
  const event = buildEvent('mistral', options);
  const result = validateEvent(event);
  assert.equal(result.ok, true, result.errors?.join(', '));
  assert.deepEqual(result.value.question, {
    question: 'Should compact density persist per browser or per user?',
    requestedAction: 'confirm the persistence scope',
  });
});

test('buildEvent omits issueNumber and title when neither flag is given', () => {
  const { options } = parseArgs(baseArgv({ 'issue-number': undefined, title: undefined }));
  const event = buildEvent('ollama', options);
  assert.equal('issueNumber' in event, false);
  assert.equal('title' in event, false);
  assert.equal(validateEvent(event).ok, true);
});

test('buildEvent defaults timestamp to the injected clock when the flag is omitted', () => {
  const { options } = parseArgs(baseArgv({ timestamp: undefined }));
  const event = buildEvent('luna', options, { now: () => '2026-08-02T00:00:00Z' });
  assert.equal(event.timestamp, '2026-08-02T00:00:00Z');
  assert.equal(validateEvent(event).ok, true);
});

test('buildEvent never invents a provider outside the closed PROVIDERS list', () => {
  const { options } = parseArgs(baseArgv());
  for (const provider of PROVIDERS) {
    assert.equal(buildEvent(provider, options).provider, provider);
  }
});
