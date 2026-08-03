import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveMetrics } from '../lib/store.mjs';
import { validateEvent, SCHEMA_VERSION, PROVIDERS } from '../lib/contract.mjs';

function event(overrides = {}) {
  return validateEvent({
    schemaVersion: SCHEMA_VERSION,
    provider: 'claude',
    repo: 'example/project',
    project: 'example-project',
    taskId: 'issue-1',
    model: 'claude-sonnet-5',
    branch: 'agent/issue-1',
    worktree: 'issue-1-impl',
    timestamp: '2026-08-01T12:00:00Z',
    state: 'implementing',
    ...overrides,
  }).value;
}

test('an empty event history reports zero completions and no blocker data for every known provider', () => {
  const metrics = deriveMetrics([]);
  for (const provider of PROVIDERS) {
    assert.deepEqual(metrics.byProvider[provider], { completed: 0, avgCompletionMs: null });
  }
  assert.deepEqual(metrics.blockers, { resolvedCount: 0, avgDurationMs: null });
});

test('a single completed task counts once for its provider with its full elapsed duration', () => {
  const events = [
    event({ state: 'queued', timestamp: '2026-08-01T12:00:00Z' }),
    event({ state: 'implementing', timestamp: '2026-08-01T12:01:00Z' }),
    event({ state: 'completed', timestamp: '2026-08-01T12:06:00Z' }),
  ];
  const metrics = deriveMetrics(events, { now: Date.parse('2026-08-01T12:10:00Z') });
  assert.deepEqual(metrics.byProvider.claude, { completed: 1, avgCompletionMs: 6 * 60 * 1000 });
});

test('completions are averaged per provider and never mixed across providers', () => {
  const events = [
    event({ provider: 'claude', taskId: 'issue-1', state: 'queued', timestamp: '2026-08-01T12:00:00Z' }),
    event({ provider: 'claude', taskId: 'issue-1', state: 'completed', timestamp: '2026-08-01T12:02:00Z' }),
    event({ provider: 'claude', taskId: 'issue-2', state: 'queued', timestamp: '2026-08-01T12:00:00Z' }),
    event({ provider: 'claude', taskId: 'issue-2', state: 'completed', timestamp: '2026-08-01T12:06:00Z' }),
    event({ provider: 'codex', taskId: 'issue-3', state: 'queued', timestamp: '2026-08-01T12:00:00Z' }),
    event({ provider: 'codex', taskId: 'issue-3', state: 'completed', timestamp: '2026-08-01T12:10:00Z' }),
  ];
  const metrics = deriveMetrics(events, { now: Date.parse('2026-08-01T12:20:00Z') });
  assert.deepEqual(metrics.byProvider.claude, { completed: 2, avgCompletionMs: 4 * 60 * 1000 });
  assert.deepEqual(metrics.byProvider.codex, { completed: 1, avgCompletionMs: 10 * 60 * 1000 });
});

test('a completed task outside the retention window is not counted', () => {
  const events = [
    event({ state: 'queued', timestamp: '2026-08-01T00:00:00Z' }),
    event({ state: 'completed', timestamp: '2026-08-01T00:05:00Z' }),
  ];
  const metrics = deriveMetrics(events, {
    now: Date.parse('2026-08-03T00:00:00Z'),
    completedRetentionMs: 24 * 60 * 60 * 1000,
  });
  assert.deepEqual(metrics.byProvider.claude, { completed: 0, avgCompletionMs: null });
});

test('a still-open blocker is not counted toward the resolved average', () => {
  const events = [
    event({ state: 'implementing', timestamp: '2026-08-01T12:00:00Z' }),
    event({
      state: 'blocked',
      timestamp: '2026-08-01T12:05:00Z',
      blocker: { cause: 'CI disk full', owner: 'sol', nextAction: 'clear cache' },
    }),
  ];
  const metrics = deriveMetrics(events, { now: Date.parse('2026-08-01T12:30:00Z') });
  assert.deepEqual(metrics.blockers, { resolvedCount: 0, avgDurationMs: null });
});

test('a resolved blocker contributes its full blocked-to-unblocked duration', () => {
  const events = [
    event({ state: 'implementing', timestamp: '2026-08-01T12:00:00Z' }),
    event({
      state: 'blocked',
      timestamp: '2026-08-01T12:05:00Z',
      blocker: { cause: 'CI disk full', owner: 'sol', nextAction: 'clear cache' },
    }),
    event({ state: 'implementing', timestamp: '2026-08-01T12:15:00Z' }),
  ];
  const metrics = deriveMetrics(events, { now: Date.parse('2026-08-01T12:30:00Z') });
  assert.deepEqual(metrics.blockers, { resolvedCount: 1, avgDurationMs: 10 * 60 * 1000 });
});

test('consecutive blocked updates (a changed cause while still blocked) count as one continuous span, not two resolutions', () => {
  const events = [
    event({ state: 'implementing', timestamp: '2026-08-01T12:00:00Z' }),
    event({
      state: 'blocked',
      timestamp: '2026-08-01T12:05:00Z',
      blocker: { cause: 'CI disk full', owner: 'sol', nextAction: 'clear cache' },
    }),
    event({
      state: 'blocked',
      timestamp: '2026-08-01T12:08:00Z',
      blocker: { cause: 'CI still full after retry', owner: 'sol', nextAction: 'escalate to infra' },
    }),
    event({ state: 'implementing', timestamp: '2026-08-01T12:20:00Z' }),
  ];
  const metrics = deriveMetrics(events, { now: Date.parse('2026-08-01T12:30:00Z') });
  assert.deepEqual(metrics.blockers, { resolvedCount: 1, avgDurationMs: 15 * 60 * 1000 });
});

test('deriveMetrics never mutates its input events', () => {
  const events = [
    event({ state: 'queued', timestamp: '2026-08-01T12:00:00Z' }),
    event({ state: 'completed', timestamp: '2026-08-01T12:05:00Z' }),
  ];
  const snapshot = JSON.parse(JSON.stringify(events));
  deriveMetrics(events, { now: Date.parse('2026-08-01T12:10:00Z') });
  assert.deepEqual(events, snapshot);
});
