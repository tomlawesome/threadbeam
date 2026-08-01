// Strict versioned event contract for the local agent delivery dashboard.
// Every event accepted here is untrusted input and is validated with a
// closed allowlist of fields, bounded lengths and content heuristics.

export const SCHEMA_VERSION = 1;

export const PROVIDERS = Object.freeze([
  'codex',
  'claude',
  'mistral',
  'ollama',
  'luna',
]);

// 'unknown' is a derived, display-only state computed from staleness. It is
// never a valid value an event may report.
export const INPUT_STATES = Object.freeze([
  'queued',
  'implementing',
  'validating',
  'waiting_ci',
  'awaiting_sol_review',
  'blocked',
  'question',
  'completed',
]);

export const DERIVED_UNKNOWN_STATE = 'unknown';
export const TERMINAL_STATES = Object.freeze(['completed']);

export const LIMITS = Object.freeze({
  repo: 100,
  project: 100,
  taskId: 100,
  title: 140,
  model: 60,
  branch: 200,
  worktree: 100,
  blockerCause: 300,
  blockerOwner: 100,
  blockerNextAction: 300,
  questionQuestion: 300,
  questionRequestedAction: 300,
  maxIssueNumber: 10_000_000,
});

const TOP_LEVEL_KEYS = Object.freeze([
  'schemaVersion',
  'provider',
  'repo',
  'project',
  'taskId',
  'issueNumber',
  'title',
  'model',
  'branch',
  'worktree',
  'timestamp',
  'state',
  'blocker',
  'question',
]);

const BLOCKER_KEYS = Object.freeze(['cause', 'owner', 'nextAction']);
const QUESTION_KEYS = Object.freeze(['question', 'requestedAction']);

// Rejects ASCII control characters (including CR/LF/TAB) so no field can
// smuggle multi-line transcript-shaped content.
const CONTROL_CHAR_RE = new RegExp('[\\x00-\\x1F\\x7F]');

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]()+ -]*$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const MIN_TIMESTAMP_MS = Date.parse('2020-01-01T00:00:00Z');
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

// Content heuristics for values that look like credentials, tokens or other
// secret-shaped material regardless of which field carries them.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{10,}\b/,
  /\bgh[opsu]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{12,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{10,}\b/i,
  /\b(?:password|passwd|secret|token|apikey|api[_-]?key|access[_-]?key)\s*[:=]\s*\S+/i,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,
  /\b[0-9a-fA-F]{32,}\b/,
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksSecretShaped(value) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function pushError(errors, code, detail) {
  errors.push(detail ? `${code}: ${detail}` : code);
}

function checkText(errors, field, value, { maxLen, pattern, required = true }) {
  if (value === undefined) {
    if (required) pushError(errors, 'missing_field', field);
    return undefined;
  }
  if (typeof value !== 'string') {
    pushError(errors, 'invalid_type', field);
    return undefined;
  }
  if (value.length < 1 || value.length > maxLen) {
    pushError(errors, 'invalid_length', field);
    return undefined;
  }
  if (CONTROL_CHAR_RE.test(value)) {
    pushError(errors, 'control_characters_not_allowed', field);
    return undefined;
  }
  if (pattern && !pattern.test(value)) {
    pushError(errors, 'invalid_format', field);
    return undefined;
  }
  if (looksSecretShaped(value)) {
    pushError(errors, 'secret_shaped_content_rejected', field);
    return undefined;
  }
  return value;
}

function validateBlocker(errors, raw) {
  if (!isPlainObject(raw)) {
    pushError(errors, 'invalid_type', 'blocker');
    return undefined;
  }
  const extra = Object.keys(raw).filter((key) => !BLOCKER_KEYS.includes(key));
  for (const key of extra) pushError(errors, 'unknown_field', `blocker.${key}`);
  const cause = checkText(errors, 'blocker.cause', raw.cause, {
    maxLen: LIMITS.blockerCause,
  });
  const owner = checkText(errors, 'blocker.owner', raw.owner, {
    maxLen: LIMITS.blockerOwner,
  });
  const nextAction = checkText(errors, 'blocker.nextAction', raw.nextAction, {
    maxLen: LIMITS.blockerNextAction,
  });
  if (extra.length > 0 || cause === undefined || owner === undefined || nextAction === undefined) {
    return undefined;
  }
  return { cause, owner, nextAction };
}

function validateQuestion(errors, raw) {
  if (!isPlainObject(raw)) {
    pushError(errors, 'invalid_type', 'question');
    return undefined;
  }
  const extra = Object.keys(raw).filter((key) => !QUESTION_KEYS.includes(key));
  for (const key of extra) pushError(errors, 'unknown_field', `question.${key}`);
  const question = checkText(errors, 'question.question', raw.question, {
    maxLen: LIMITS.questionQuestion,
  });
  const requestedAction = checkText(errors, 'question.requestedAction', raw.requestedAction, {
    maxLen: LIMITS.questionRequestedAction,
  });
  if (extra.length > 0 || question === undefined || requestedAction === undefined) {
    return undefined;
  }
  return { question, requestedAction };
}

function isValidTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) return false;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  if (ms < MIN_TIMESTAMP_MS) return false;
  if (ms > Date.now() + MAX_FUTURE_SKEW_MS) return false;
  return true;
}

/**
 * Validates an untrusted lifecycle event against the strict contract.
 * @returns {{ok: boolean, errors: string[], value: object|null}}
 */
export function validateEvent(raw) {
  const errors = [];

  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['invalid_type: event'], value: null };
  }

  const unknownKeys = Object.keys(raw).filter((key) => !TOP_LEVEL_KEYS.includes(key));
  for (const key of unknownKeys) pushError(errors, 'unknown_field', key);

  if (raw.schemaVersion !== SCHEMA_VERSION) {
    pushError(errors, 'unsupported_schema_version');
  }

  if (!PROVIDERS.includes(raw.provider)) {
    pushError(errors, 'invalid_provider');
  }

  const repo = checkText(errors, 'repo', raw.repo, { maxLen: LIMITS.repo, pattern: REPO_RE });
  const project = checkText(errors, 'project', raw.project, {
    maxLen: LIMITS.project,
    pattern: LABEL_RE,
  });
  const taskId = checkText(errors, 'taskId', raw.taskId, {
    maxLen: LIMITS.taskId,
    pattern: TASK_ID_RE,
  });

  let issueNumber;
  if (raw.issueNumber !== undefined) {
    if (
      typeof raw.issueNumber !== 'number' ||
      !Number.isInteger(raw.issueNumber) ||
      raw.issueNumber < 1 ||
      raw.issueNumber > LIMITS.maxIssueNumber
    ) {
      pushError(errors, 'invalid_issue_number');
    } else {
      issueNumber = raw.issueNumber;
    }
  }

  const title = checkText(errors, 'title', raw.title, {
    maxLen: LIMITS.title,
    required: raw.issueNumber !== undefined,
  });

  const model = checkText(errors, 'model', raw.model, { maxLen: LIMITS.model, pattern: MODEL_RE });

  const branch = checkText(errors, 'branch', raw.branch, {
    maxLen: LIMITS.branch,
    pattern: BRANCH_RE,
  });
  if (branch !== undefined && branch.includes('..')) {
    pushError(errors, 'invalid_format', 'branch');
  }

  // Worktree is a sanitized label only: no path separators, so it can never
  // encode an absolute path or a traversal sequence.
  const worktree = checkText(errors, 'worktree', raw.worktree, {
    maxLen: LIMITS.worktree,
    pattern: LABEL_RE,
  });

  if (!isValidTimestamp(raw.timestamp)) {
    pushError(errors, 'invalid_timestamp');
  }

  if (raw.state === DERIVED_UNKNOWN_STATE) {
    pushError(errors, 'state_unknown_is_derived_only');
  } else if (!INPUT_STATES.includes(raw.state)) {
    pushError(errors, 'invalid_state');
  }

  let blocker;
  if (raw.state === 'blocked') {
    blocker = validateBlocker(errors, raw.blocker);
  } else if (raw.blocker !== undefined) {
    pushError(errors, 'blocker_only_allowed_when_blocked');
  }

  let question;
  if (raw.state === 'question') {
    question = validateQuestion(errors, raw.question);
  } else if (raw.question !== undefined) {
    pushError(errors, 'question_only_allowed_when_question_state');
  }

  if (errors.length > 0) {
    return { ok: false, errors, value: null };
  }

  const value = {
    schemaVersion: SCHEMA_VERSION,
    provider: raw.provider,
    repo,
    project,
    taskId,
    ...(issueNumber !== undefined ? { issueNumber } : {}),
    ...(title !== undefined ? { title } : {}),
    model,
    branch,
    worktree,
    timestamp: raw.timestamp,
    state: raw.state,
    ...(blocker ? { blocker } : {}),
    ...(question ? { question } : {}),
  };

  return { ok: true, errors: [], value };
}
