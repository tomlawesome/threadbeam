# Provider adapters

Threadbeam's event contract (`lib/contract.mjs`) is already provider-agnostic
— every field is the same regardless of which bounded-task wrapper produced
it. The adapters in `adapters/` exist only to make emitting a well-formed
event from a wrapper's hook script convenient: each is a thin CLI that takes
a closed set of `--flag=value` arguments, shapes them into the exact event
contract, and pipes the result to the real `bin/emit.mjs` stdin emitter — the
same validated path a manual `echo '{...}' | node bin/emit.mjs` uses. An
adapter can never bypass `lib/contract.mjs`'s validation, and it never reads
anything beyond the flags it was given: no transcript, tool-call log, source
file, diff, or credential ever passes through it.

One adapter script exists per maintained bounded-task wrapper: `codex.mjs`,
`claude.mjs`, `mistral.mjs`, `ollama.mjs`, `luna.mjs`. Each is independent —
use whichever ones are actually available in your environment; there is no
requirement to wire up all five.

## Integrating from another repository

No changes to Threadbeam's own source are required. From the other
repository's own hook script (run after each bounded-task lifecycle
transition), invoke the adapter that matches the provider that just ran,
passing the task's identity and new state as flags:

```sh
node /path/to/threadbeam/adapters/claude.mjs \
  --repo=myorg/myrepo \
  --project=myrepo \
  --task-id=issue-12 \
  --issue-number=12 \
  --title="Add pagination to the delivery view" \
  --model=claude-sonnet-5 \
  --branch=agent/issue-12-delivery-view \
  --worktree=issue-12-implementation \
  --state=implementing
```

`/path/to/threadbeam` can be a sibling checkout, a git submodule, or any path
reachable from the calling repository — the adapter itself has no dependency
on being invoked from inside the Threadbeam repository.

If the calling process already has a `THREADBEAM_STORE_DIR` set (or is
running where Threadbeam's default `~/.threadbeam` is the right target), no
further configuration is needed; the adapter's `node bin/emit.mjs` child
process inherits it exactly like any other command would.

Exit code `0` and `accepted` on stdout mean the event was validated and
appended. A non-zero exit code and a rejection reason on stderr mean the
event was **not** written — the same fail-closed behaviour as a manual emit.

## Flag reference

| Flag | Required | Notes |
|---|---|---|
| `--repo` | yes | `owner/name` |
| `--project` | yes | bounded label |
| `--task-id` | yes | bounded label |
| `--issue-number` | no | positive integer; requires `--title` |
| `--title` | conditional | required whenever `--issue-number` is set |
| `--model` | yes | free-form within the contract's bounds |
| `--branch` | yes | bounded label, never a filesystem path |
| `--worktree` | yes | bounded label, never a filesystem path |
| `--state` | yes | `queued`, `implementing`, `validating`, `waiting_ci`, `awaiting_sol_review`, `blocked`, `question`, or `completed` (never `unknown` — that's derived) |
| `--timestamp` | no | ISO-8601 UTC; defaults to the current time if omitted |
| `--blocker-cause` / `--blocker-owner` / `--blocker-next-action` | only when `--state=blocked` | all three required together |
| `--question` / `--question-requested-action` | only when `--state=question` | both required together |

Any flag outside this list — including anything that looks like it might
carry a transcript, tool call, diff, prompt, or shell command — is rejected
outright, and no event is emitted. This is a closed allowlist, not a
best-effort filter.

## Adding a wrapper that isn't in the maintained list

Copy one of the existing per-provider files (they are a few lines each) and
change only the fixed provider name passed to `runCli`, provided that name is
one of `lib/contract.mjs`'s `PROVIDERS`. Adding a genuinely new provider name
to the contract itself is a schema change, not an adapter change.
