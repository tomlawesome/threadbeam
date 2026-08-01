#!/usr/bin/env node
// Stdin-only event emitter. Reads exactly one JSON event from stdin,
// validates it against the strict contract and appends it to the private
// JSONL store. It takes no content from argv and never reads any other
// file, session transcript or tool-call log.

import { validateEvent } from '../lib/contract.mjs';
import { appendEvent, defaultStoreDir } from '../lib/store.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_STDIN_BYTES = 16_384;

async function readStdin() {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    totalBytes += chunk.byteLength;
    if (totalBytes > MAX_STDIN_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

export async function run({ input, storeDir = defaultStoreDir() } = {}) {
  const raw = input === undefined ? await readStdin() : input;

  if (raw === null || typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_STDIN_BYTES) {
    return { ok: false, errors: ['stdin_too_large'] };
  }

  if (!raw || !raw.trim()) {
    return { ok: false, errors: ['no_event_on_stdin'] };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ['stdin_not_valid_json'] };
  }

  const result = validateEvent(parsed);
  if (!result.ok) {
    return { ok: false, errors: result.errors };
  }

  await appendEvent(storeDir, result.value);
  return { ok: true, errors: [] };
}

function isMain() {
  return Boolean(
    process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href,
  );
}

if (isMain()) {
  run()
    .then((result) => {
      if (!result.ok) {
        process.stderr.write(`agent-dashboard emit: rejected event\n${result.errors.join('\n')}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write('accepted\n');
    })
    .catch((err) => {
      process.stderr.write(`agent-dashboard emit: ${err.message}\n`);
      process.exitCode = 1;
    });
}
