# Contributing

Threadbeam does not accept outside pull requests. Bug reports and issues are
welcome from anyone, but are treated as information for the maintainer, not
as work items to be actioned.

## Before opening a change

Changes are made by the maintainer (or an agent working under their
direction), never by outside contributors. Before opening a change:

1. Open or reference an issue describing the user outcome, non-goals, security
   impact, and test plan.
2. Work on a short-lived branch from the latest `dev`. Three lanes, same
   model as this project's siblings (`mikroview`, `birdcage`):
   - **`dev`** -- unprotected, fast-moving. All issue work targets this.
     CI here is deliberately light: `npm test` only, no container build,
     no CodeQL. This is where the messy stuff happens.
   - **`preview`** -- protected, PR-only (from `dev`). Gets the full
     gate: the container smoke test and CodeQL. A merge here builds and
     publishes the actual release candidate image
     (`ghcr.io/tomlawesome/threadbeam:preview`).
   - **`main`** -- protected, PR-only (from `preview`). A merge here
     never rebuilds anything; it retags the exact digest that was
     already built and tested from `preview` as `:latest`. Only what's
     actually ready ends up here.
3. Add regression coverage before fixing a defect.
4. Keep dependencies at zero unless a clear, reviewed benefit justifies a new
   maintenance and supply-chain surface.

## Validate locally

```sh
npm test
docker compose config --quiet
docker build -t threadbeam:test .
```

Do not include a real event store, credentials, private repository data,
transcripts, generated logs, or screenshots containing sensitive information.

All required GitHub checks must pass before merge.

## Security by design

New features are researched before they are designed — including an
explicit CVE search and a comparison against known secure and insecure
implementations. See
[docs/security-by-design.md](docs/security-by-design.md) for what that
requires and why.
