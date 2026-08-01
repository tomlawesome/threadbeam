# Agent dashboard (local, read-only)

A dependency-free, self-contained status dashboard for watching in-flight
agent delivery tasks across software projects. It is a developer visibility
tool, not application functionality, and does not depend on or ship with any
project it observes.

## Start it

```
node tools/agent-dashboard/server.mjs
```

This uses only Node 22 built-ins, so no install step is required. The server
defaults to `127.0.0.1:4317`. The port can be changed with
`AGENT_DASHBOARD_PORT`.

To let developers browse it from a trusted local network, bind it explicitly
to the host's LAN address:

```
AGENT_DASHBOARD_HOST=192.168.1.20 node tools/agent-dashboard/server.mjs
```

`AGENT_DASHBOARD_HOST` must be an explicit IPv4 or IPv6 address. `0.0.0.0`
is supported when every host-facing interface is trusted, but binding the
specific LAN address is safer. This version intentionally has no login: keep
it behind a host/network firewall and never expose it to the internet or an
untrusted network.

## Event contract

Lifecycle events are validated against a strict, versioned, closed-field
schema (`lib/contract.mjs`, `schemaVersion: 1`):

- `provider`: one of `codex`, `claude`, `mistral`, `ollama`, `luna`.
- `repo`, `project`: repository/project identity labels.
- `taskId`: a bounded, sanitized identifier for the task; common punctuation
  such as `:` is accepted.
- `issueNumber` (optional): a positive integer.
- `title`: a concise, single-line summary, required whenever `issueNumber` is
  present so issue references are always displayed as `#number — title`.
- `model`, `branch`: bounded identifiers. Model names may use ordinary
  provider punctuation and spaces, such as `qwen2.5-coder:7b`.
- `worktree`: a sanitized **label**, not a path — absolute paths and path
  separators are rejected outright.
- `timestamp`: a strict ISO-8601 UTC timestamp within a sane range.
- `state`: one of `queued`, `implementing`, `validating`, `waiting_ci`,
  `awaiting_sol_review`, `blocked`, `question`, `completed`. `unknown` is a
  **derived** display state computed from staleness; no event may report it.
- `blocker` (`cause`, `owner`, `nextAction`): required only when
  `state: "blocked"`.
- `question` (`question`, `requestedAction`): required only when
  `state: "question"`.

Unknown top-level or nested keys, malformed types, overlong strings, control
characters (which would allow multi-line transcript-shaped content), invalid
timestamps, and values that look like credentials, tokens, or private keys
are all rejected. See `lib/contract.mjs` for the exact limits and patterns.

## Emitting events

Events are appended with a stdin-only CLI. It never reads argv content and
never inspects any agent session, transcript or tool-call file — it only
validates whatever single JSON object is piped to it:

```
echo '{
  "schemaVersion": 1,
  "provider": "claude",
  "repo": "example/project",
  "project": "example-project",
  "taskId": "issue-175",
  "issueNumber": 175,
  "title": "Agent delivery dashboard",
  "model": "claude-sonnet-5",
  "branch": "codex/issue-175-agent-dashboard",
  "worktree": "issue-175-claude",
  "timestamp": "2026-08-01T12:00:00Z",
  "state": "implementing"
}' | node tools/agent-dashboard/bin/emit.mjs
```

Rejected events are never written; the CLI exits non-zero and prints the
validation failure reasons to stderr. Stdin is capped at 16 KiB.

## Storage and retention

Events are appended as one JSON object per line to a private JSONL file
(mode `0600`) inside a private directory (mode `0700`), created if missing.
The default location is `~/.agent-delivery-dashboard`; override it for both the
server and the emitter with `AGENT_DASHBOARD_STORE_DIR`. Appends use
`O_NOFOLLOW` so a symlinked events file is refused rather than followed.
Existing owner-controlled store permissions are tightened to `0700`/`0600`.
The append-only log has a fail-closed 8 MB growth limit; operators should
archive or remove an old store explicitly when that limit is reached.

Reads are bounded: only the trailing window of the file (bytes and line
count) is parsed, so an oversized or corrupted file cannot exhaust memory.
Malformed or contract-invalid lines are skipped and counted, never exposed
through the API, and never crash the service. Completed
tasks age out of the visible history after a bounded retention window, and
any non-terminal task that stops receiving updates is shown as the derived
`unknown` state rather than being silently dropped or assumed successful —
absence is never treated as completion.

## Privacy boundary

This tool only ever stores and displays the small, strictly validated fields
above. It does not read, store or display transcripts, tool call logs,
source diffs, credentials, or any other session content, and the read-only
API exposes no write, launch, steering, approval, merge, stop, Docker, shell
or GitHub capability — only `GET`/`HEAD` on the status API and the static UI.

## Later integration point (not in this slice)

A future wrapper adapter could translate real Codex/Claude/Mistral/
Ollama/Luna provider wrapper lifecycle output into calls to the stdin-only
emitter above. That adapter is **not implemented** in this slice — this
slice only provides the contract, storage, server, UI and emitter.

## Tests

```
node --test tools/agent-dashboard/test/*.node-test.mjs
```

Tests cover contract rejection (unknown fields, malformed values, secret-
shaped content, invalid timestamps, absolute worktree paths), store behaviour
(symlink refusal, malformed-line recovery, staleness/retention bounds), and
the server (safe default and explicit trusted-LAN binding, GET/HEAD-only
methods, path traversal
resistance, security headers, and core accessible rendering semantics).
