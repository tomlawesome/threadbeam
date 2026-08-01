# Security policy

## Supported version

Threadbeam is pre-1.0. Security fixes target the latest commit on `main` until
versioned releases begin.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do
not place exploit details, credentials, private event data, or sensitive logs
in a public issue.

## Deployment boundary

Threadbeam intentionally has no login. It is supported only on loopback or an
explicitly trusted developer network protected by host and network controls.
Do not expose it to the internet or an untrusted network.

The service is read-only, but lifecycle metadata can still reveal project,
branch, issue, model, blocker, and timing information. Treat its event store as
private operational data.

## Event safety

Only the documented closed event schema is accepted. Threadbeam must never be
given transcripts, prompts, source code, diffs, tool-call logs, credentials,
private keys, or arbitrary agent output. If sensitive content is accidentally
written, stop the service, secure or remove the event store, and rotate any
exposed credential before resuming.
