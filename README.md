# Threadbeam

Threadbeam is a lightweight, self-hosted dashboard for seeing concurrent AI
coding-agent work, blockers, questions, and delivery status at a glance.

It is deliberately read-only. Threadbeam accepts small, validated lifecycle
events; it does not inspect agent transcripts, read source code, launch agents,
run shell commands, or mutate GitHub.

## What it provides

- a live task table with sortable columns;
- prominent blockers and questions;
- bounded completion history and a timestamp-focused timeline;
- clickable summary counters with an explicit **View all** reset;
- five full-page colour themes plus light and dark modes;
- automatic five-second refresh without remote assets or analytics;
- a strict stdin-only event emitter and owner-private JSONL store;
- loopback-safe native defaults and a hardened container example.

## Native quick start

Threadbeam uses only Node.js 22 built-ins. No dependency installation is
required.

```sh
node server.mjs
```

Open <http://127.0.0.1:4317>. Change the port with `THREADBEAM_PORT`.

To make Threadbeam available on a trusted developer LAN, bind it to the exact
LAN address of the host:

```sh
THREADBEAM_HOST=192.168.1.20 node server.mjs
```

`THREADBEAM_HOST` must be an explicit IPv4 or IPv6 address. `0.0.0.0` is
accepted only for environments where every host-facing interface is trusted.
Threadbeam has no login and must never be exposed to the internet or an
untrusted network.

## Container quick start

The included Compose configuration publishes Threadbeam only on host loopback
by default:

```sh
docker compose up -d --build
```

Open <http://127.0.0.1:4317>. The container runs unprivileged with all Linux
capabilities dropped, a read-only root filesystem, and a dedicated persistent
event volume.

To publish on one trusted LAN address instead, set `THREADBEAM_PUBLISH_ADDRESS`
for that invocation:

```sh
THREADBEAM_PUBLISH_ADDRESS=192.168.1.20 docker compose up -d --build
```

## Emitting an event

Events are accepted only as one JSON object on stdin. The emitter reads no
command-line content and no session, transcript, tool-call, or source file.

```sh
echo '{
  "schemaVersion": 1,
  "provider": "claude",
  "repo": "example/project",
  "project": "example-project",
  "taskId": "issue-42",
  "issueNumber": 42,
  "title": "Improve the delivery view",
  "model": "Claude Sonnet 5",
  "branch": "agent/issue-42-delivery-view",
  "worktree": "issue-42-implementation",
  "timestamp": "2026-08-02T00:00:00Z",
  "state": "implementing"
}' | node bin/emit.mjs
```

For the container deployment, pipe the same JSON to a one-off emitter that
shares the private event volume:

```sh
echo '{...}' | docker compose run --rm -T threadbeam node bin/emit.mjs
```

Rejected events are never written. Stdin is capped at 16 KiB.

Crafting that JSON by hand isn't required: `adapters/` provides a small CLI
per maintained bounded-task wrapper (Codex, Claude, Mistral, Ollama, Luna)
that takes the same fields as flags and emits through this exact stdin path.
See [docs/adapters.md](docs/adapters.md) for the flag reference and how to
call one from another repository's own hook script.

## Event contract

The closed, versioned schema is defined in `lib/contract.mjs`.

- `provider`: `codex`, `claude`, `mistral`, `ollama`, or `luna`;
- `repo`, `project`, `taskId`, `model`, `branch`, `worktree`: bounded identity
  labels; `worktree` is a label, never a filesystem path;
- `issueNumber`: optional positive integer;
- `title`: concise single-line text, required with an issue number;
- `timestamp`: strict ISO-8601 UTC timestamp;
- `state`: `queued`, `implementing`, `validating`, `waiting_ci`,
  `awaiting_sol_review`, `blocked`, `question`, or `completed`;
- `blocker`: required only for `blocked`, with `cause`, `owner`, and
  `nextAction`;
- `question`: required only for `question`, with `question` and
  `requestedAction`.

`unknown` is derived when a non-terminal task becomes stale; emitters cannot
claim it. Unknown fields, malformed types, overlong strings, control
characters, unsafe paths, invalid timestamps, and secret-shaped values are
rejected.

## Storage and privacy

The default store is `~/.threadbeam/events.jsonl`; override the directory with
`THREADBEAM_STORE_DIR`. The directory and file are restricted to their owner
(`0700` and `0600`). Symlinked stores are refused, reads are bounded, malformed
lines are skipped and counted, completed history expires, and the append-only
log fails closed at its size limit.

The HTTP service exposes only static files and `GET`/`HEAD /api/status`. It has
no write, launch, steering, approval, merge, stop, Docker, shell, or GitHub
endpoint. See [SECURITY.md](SECURITY.md) and
[docs/architecture.md](docs/architecture.md) for the maintained boundary.

## Development

```sh
npm test
```

The test suite covers contract rejection, secret-shaped content, store
ownership and symlink safety, bounded retention, safe HTTP methods and paths,
security headers, themes, filtering, sorting, and responsive accessibility
contracts.

Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md). Threadbeam is licensed
under the [MIT License](LICENSE).
