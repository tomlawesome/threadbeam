> [!IMPORTANT]
> **Development disclosure:** Threadbeam was coded by AI coding agents
> (Claude and Mistral) under human direction.

<p align="center">
  <img src="docs/assets/threadbeam-logo.svg" alt="Threadbeam" width="420">
</p>

<p align="center">
  A lightweight, self-hosted, deliberately read-only dashboard for seeing
  concurrent AI coding-agent work, blockers, questions, and delivery status at
  a glance.
</p>

<p align="center">
  <em>Node.js 22 built-ins only &middot; no dependencies &middot; no login
  &middot; loopback by default</em>
</p>

A one-page overview with the same screenshots lives in
[`site/`](site/index.html) (open `site/index.html` directly, or serve the
directory statically).

## At a glance

Threadbeam turns a closed, validated stream of lifecycle events into one live
view of what each agent is working on, what is blocked, what needs an answer,
and what has landed.

- **Run it:** `node server.mjs`, then open <http://127.0.0.1:4317>.
- **Feed it:** one JSON lifecycle event per emitter invocation, on stdin only.
- **It never reads:** transcripts, prompts, tool-call logs, source files, diffs,
  or credentials.
- **It never controls:** it cannot launch, steer, approve, or stop an agent, run
  shell commands, drive Docker, or write to GitHub.

![The Threadbeam dashboard: summary counters, a live task table of concurrent
agent tasks, prominent blockers and questions, and a completion
timeline.](docs/assets/threadbeam-dashboard.png)

## What it provides

- a live task table with sortable columns;
- prominent blockers and questions;
- a per-project breakdown of active/blocker/question/completed counts, once
  more than one project is active;
- delivery metrics: completions and average completion time per provider,
  and average blocker resolution time;
- bounded completion history and a timestamp-focused timeline;
- clickable summary counters with an explicit **View all** reset;
- opt-in browser notifications for new blockers and questions;
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

To make this persistent instead of setting the variable on every invocation,
copy [`.env.example`](.env.example) to `.env` and fill in this host's LAN
address -- Compose loads `.env` automatically, and it's already gitignored
so the value stays local to this machine:

```sh
cp .env.example .env
# edit .env and set THREADBEAM_PUBLISH_ADDRESS to this host's LAN IP
docker compose up -d --build
```

This still uses the default bridge network with a port published to one
host interface -- it does not put the container on the host network.
Threadbeam has no login, so only bind it to a network you trust.

### Prebuilt image

Every push to `main` (release) or `dev` (day-to-day) builds and publishes an
image via GitHub Actions (see `.github/workflows/docker-publish.yml`):

```sh
docker pull ghcr.io/tomlawesome/threadbeam:latest   # main, released
docker pull ghcr.io/tomlawesome/threadbeam:dev       # dev, latest build
```

If `docker pull` reports the image as not found/unauthorized, the GHCR
package is likely still set to private -- open the package settings on
GitHub (repo → Packages → threadbeam) and set visibility to public, or
`docker login ghcr.io` first with a PAT that has `read:packages` scope.

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

"Stale" defaults to 20 minutes since the last event; override it with
`THREADBEAM_STALE_MINUTES` (a positive whole number of minutes) if your
agents have a different natural cadence. Unset, non-numeric, or non-positive
values fall back to the default rather than failing to start.

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
