#!/usr/bin/env node
// Bounded-task adapter for Codex. See docs/adapters.md for the flag
// reference and an integration example from another repository.
import { isCliInvocation, runCli } from './lib/run-adapter.mjs';

if (isCliInvocation(process.argv[1], import.meta.url)) {
  runCli('codex');
}
