# Threadbeam agent instructions

These instructions apply to every automated agent working in this repository,
alongside the global agent instructions.

## Authority and orchestration

- Sol Extra High owns project planning, architecture, security, model
  governance, delivery sequencing, integration, release decisions, and
  repository governance.
- Implementation may be delegated only as a bounded slice with an exact base,
  isolated worktree, permitted paths, acceptance criteria, tests, stop
  conditions, and a result handback. The implementation provider receives no
  planning, security, GitHub, merge, release, or integration authority.
- Prefer the cheapest qualified idle implementation resource: a validated
  local Ollama model, then Mistral, then Claude. Use Claude concurrently when
  its additional capability or an occupied cheaper provider creates a real
  throughput benefit. Luna is the last implementation fallback.
- Do not constrain correct work with arbitrary token limits. Detect genuine
  stalls using task- and model-appropriate time to useful output or time since
  meaningful progress, with a reasonable buffer.
- Keep no more than two pull requests in flight. Concurrent slices must have
  disjoint paths and remain valid whichever sibling lands first.
- Sol independently reviews delegated diffs, tests, privacy, credentials,
  dependencies, and scope before publication.

## Product boundary

- Threadbeam is a standalone, read-only developer visibility tool.
- It may accept only the documented, closed lifecycle-event schema.
- It must never ingest transcripts, prompts, tool-call logs, source files,
  diffs, credentials, private keys, or arbitrary agent output.
- It must never gain agent launch, steering, approval, merge, shell, Docker,
  GitHub-write, or repository-mutation capability.
- The HTTP service has no login and is supported only on loopback or an
  explicitly trusted developer network. Internet exposure is unsupported.
- Preserve owner-private storage, bounded reads and retention, safe logging,
  fail-closed validation, strict HTTP methods, and security headers.

## Delivery workflow

- Start non-trivial work from a scoped issue with outcome, acceptance, security
  impact, tests, non-goals, and closure evidence.
- Write a failing test first for defects and testable behaviour changes.
- Run syntax and unit checks before container or browser checks.
- Required GitHub CI is authoritative before merge. Do not weaken tests or
  bypass protections to make a change pass.
- Pin third-party CI actions and container bases to reviewed immutable SHAs or
  digests. Keep CI permissions minimal.
- Before every commit or push, inspect the exact diff and untracked files for
  generated artifacts and unrelated changes.
- Never commit private operational event stores.

## Definition of done

- Requested behaviour and negative/security cases are tested.
- Native and container paths remain consistent where applicable.
- Documentation reflects real behaviour and safety boundaries.
- The final diff is reviewed and contains no unrelated or sensitive material.
- Required checks pass, the issue has linked closure evidence, and temporary
  branches or worktrees are reconciled safely.

## Outside contributions

Outside pull requests are not accepted at all — see `CONTRIBUTING.md`.
(Instruction authority and treatment of outside issues/comments follow the
global agent instructions.)
