// Shared core for the per-provider adapter CLIs (see ../codex.mjs, etc.).
// An adapter's only job is: take a closed, explicit set of CLI flags
// describing one bounded-task lifecycle transition, shape it into the exact
// event contract from lib/contract.mjs, and hand it to the real stdin
// emitter -- never anything read from a file, transcript, tool call, or
// arbitrary environment value.
import { SCHEMA_VERSION } from '../../lib/contract.mjs';

// Every flag an adapter will ever recognise. Deliberately closed: there is
// no passthrough/"extra" flag, so a caller cannot smuggle transcript, tool,
// or source-shaped content through an adapter even if it tried to.
export const KNOWN_FLAGS = Object.freeze([
  'repo',
  'project',
  'task-id',
  'issue-number',
  'title',
  'model',
  'branch',
  'worktree',
  'state',
  'timestamp',
  'blocker-cause',
  'blocker-owner',
  'blocker-next-action',
  'question',
  'question-requested-action',
]);

const FLAG_RE = /^--([a-z][a-z0-9-]*)=([\s\S]*)$/;

/**
 * Parses `--flag=value` arguments against the closed KNOWN_FLAGS allowlist.
 * @returns {{options: Record<string,string>, unknownFlags: string[]}}
 */
export function parseArgs(argv) {
  const options = {};
  const unknownFlags = [];

  for (const arg of argv) {
    const match = FLAG_RE.exec(arg);
    if (!match) {
      unknownFlags.push(arg);
      continue;
    }
    const [, flag, value] = match;
    if (!KNOWN_FLAGS.includes(flag)) {
      unknownFlags.push(flag);
      continue;
    }
    options[flag] = value;
  }

  return { options, unknownFlags };
}

/**
 * Builds the exact lifecycle-event object for `provider` from parsed CLI
 * options. Performs no validation itself -- lib/contract.mjs's
 * validateEvent (run inside bin/emit.mjs) is the single source of truth for
 * that, so an adapter can never drift from what a manual emit would accept.
 */
export function buildEvent(provider, options, { now = () => new Date().toISOString() } = {}) {
  const event = {
    schemaVersion: SCHEMA_VERSION,
    provider,
    repo: options.repo,
    project: options.project,
    taskId: options['task-id'],
    model: options.model,
    branch: options.branch,
    worktree: options.worktree,
    timestamp: options.timestamp ?? now(),
    state: options.state,
  };

  if (options['issue-number'] !== undefined) {
    const parsed = Number(options['issue-number']);
    event.issueNumber = Number.isInteger(parsed) ? parsed : options['issue-number'];
  }
  if (options.title !== undefined) event.title = options.title;

  if (options.state === 'blocked') {
    event.blocker = {
      cause: options['blocker-cause'],
      owner: options['blocker-owner'],
      nextAction: options['blocker-next-action'],
    };
  }
  if (options.state === 'question') {
    event.question = {
      question: options.question,
      requestedAction: options['question-requested-action'],
    };
  }

  return event;
}
