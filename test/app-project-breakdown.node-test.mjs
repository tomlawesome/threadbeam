import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupCountsByProject } from '../public/app.js';

function task(overrides = {}) {
  return { project: 'threadbeam', repo: 'example/threadbeam', taskId: 'issue-1', ...overrides };
}

test('an empty status produces no rows', () => {
  assert.deepEqual(groupCountsByProject({ live: [], blockers: [], questions: [], completed: [] }), []);
});

test('a task counts in every bucket it appears in, matching the non-exclusive global counters', () => {
  const blocked = task({ taskId: 'issue-2' });
  const rows = groupCountsByProject({ live: [blocked], blockers: [blocked], questions: [], completed: [] });
  assert.deepEqual(rows, [{ project: 'threadbeam', live: 1, blockers: 1, questions: 0, completed: 0 }]);
});

test('different projects are broken out into separate rows, sorted alphabetically', () => {
  const rows = groupCountsByProject({
    live: [task({ project: 'zeta', repo: 'example/zeta' }), task({ project: 'alpha', repo: 'example/alpha' })],
    blockers: [],
    questions: [],
    completed: [],
  });
  assert.deepEqual(rows.map((r) => r.project), ['alpha', 'zeta']);
  assert.equal(rows[0].live, 1);
  assert.equal(rows[1].live, 1);
});

test('projects are keyed by display name (last path segment), so repo and project variants of the same name merge', () => {
  const rows = groupCountsByProject({
    live: [task({ project: 'threadbeam', repo: 'example/threadbeam' })],
    blockers: [],
    questions: [],
    completed: [task({ project: 'threadbeam', repo: 'other-org/threadbeam', taskId: 'issue-9' })],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].live, 1);
  assert.equal(rows[0].completed, 1);
});

test('falls back to the raw repo when project is missing entirely', () => {
  const rows = groupCountsByProject({ live: [{ repo: 'example/fallback-repo', taskId: 'issue-1' }], blockers: [], questions: [], completed: [] });
  assert.equal(rows[0].project, 'fallback-repo');
});

test('missing status arrays are treated as empty rather than throwing', () => {
  assert.deepEqual(groupCountsByProject({}), []);
});
