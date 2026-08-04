# Architecture and trust boundary

Threadbeam has four deliberately small components:

1. `bin/emit.mjs` reads one bounded JSON object from stdin.
2. `lib/contract.mjs` validates it against a closed versioned schema and
   rejects unsafe or secret-shaped content.
3. `lib/store.mjs` appends validated events to an owner-private JSONL log and
   derives bounded current status.
4. `server.mjs` serves static assets plus a read-only status endpoint.

The browser polls `/api/status` every five seconds. There are no remote assets,
analytics, cookies, accounts, or write endpoints.

## Trust boundaries

- Event producers are untrusted. Every field is type, length, character,
  timestamp, path, and secret-pattern checked before persistence.
- The event store is private operational data. It is owner-only, append-only,
  symlink-resistant, size-bounded, and parsed through bounded reads.
- Browser clients are trusted developers on loopback or a trusted LAN. The UI
  uses `textContent`, a restrictive content security policy, and no inline or
  remote executable content.
- Provider adapters (see [docs/adapters.md](adapters.md)) may translate
  wrapper lifecycle states into the event schema, but they may not pass
  transcripts or grant providers access to the Threadbeam store or HTTP
  service.

## Explicit non-capabilities

Threadbeam cannot launch, stop, steer, approve, merge, publish, or authenticate
agents. It cannot execute shell or Docker commands, read repositories, or write
to GitHub. Adding any such capability is an architecture and security change,
not an ordinary feature.
