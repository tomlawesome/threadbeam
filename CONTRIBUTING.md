# Contributing

Threadbeam welcomes focused bug reports and pull requests that preserve its
small, read-only security boundary.

## Before opening a change

1. Open or reference an issue describing the user outcome, non-goals, security
   impact, and test plan.
2. Work on a short-lived branch from the latest `dev` -- `dev` is where
   day-to-day work lands and builds a `:dev` container image on every push;
   `main` is the release branch, promoted from `dev` deliberately, and
   builds the `:latest` image.
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
