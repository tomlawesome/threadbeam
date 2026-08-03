// Spawns the real bin/emit.mjs and pipes one JSON event to its stdin --
// adapters emit only through the stdin emitter, the same closed path a
// manual `echo '{...}' | node bin/emit.mjs` invocation uses, so they can
// never bypass lib/contract.mjs's validation.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { PROVIDERS } from '../../lib/contract.mjs';
import { parseArgs, buildEvent, KNOWN_FLAGS } from './build-event.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMIT_PATH = path.resolve(__dirname, '../../bin/emit.mjs');

function runEmit({ input, execPath = process.execPath, emitPath = EMIT_PATH, spawnFn = spawn, env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(execPath, [emitPath], { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/**
 * Parses argv for `provider`, builds the contract-shaped event, and pipes it
 * to the real emitter. Returns a result the CLI wrapper can report and exit
 * on; never throws for a caller-input problem (unknown flag, rejected
 * event) -- only for an environment-level failure (emit.mjs not spawnable).
 */
export async function runAdapter({ provider, argv, execPath, emitPath, spawnFn, env, now }) {
  if (!PROVIDERS.includes(provider)) {
    return { ok: false, errors: [`unknown_provider: ${provider}`] };
  }

  const { options, unknownFlags } = parseArgs(argv);
  if (unknownFlags.length > 0) {
    return {
      ok: false,
      errors: unknownFlags.map((flag) => `unknown_flag: ${flag}`),
      knownFlags: KNOWN_FLAGS,
    };
  }

  const event = buildEvent(provider, options, { now });
  const { code, stdout, stderr } = await runEmit({
    input: JSON.stringify(event),
    execPath,
    emitPath,
    spawnFn,
    env,
  });

  if (code !== 0) {
    return { ok: false, errors: [stderr.trim() || stdout.trim() || `emit exited with code ${code}`] };
  }
  return { ok: true, errors: [] };
}

export function isCliInvocation(argv1, moduleUrl) {
  return Boolean(argv1 && moduleUrl === pathToFileURL(path.resolve(argv1)).href);
}

/**
 * Shared CLI wrapper each thin per-provider script (../codex.mjs, etc.)
 * calls with its own fixed provider name -- so provider is never itself a
 * caller-supplied flag, and each script stays a few lines long.
 */
export async function runCli(provider) {
  const result = await runAdapter({ provider, argv: process.argv.slice(2) });
  if (!result.ok) {
    process.stderr.write(`threadbeam ${provider} adapter: rejected event\n${result.errors.join('\n')}\n`);
    if (result.knownFlags) {
      process.stderr.write(`known flags: ${result.knownFlags.map((f) => `--${f}`).join(', ')}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write('accepted\n');
}
