// Preflight for "try errors on every feature".
//
// Background:
//   On real hardware, passing a non-URL string to `/genspark-crawl` produced an error display and then
//   failed the whole turn in session-format V4 validation ("this turn failed to run:
//   format v4 message requires a producer-owned source kind"). Users pointed out that
//   "error handling is not working at all" and "did you try error tests on every feature?".
//
// This preflight mechanically runs the possible failure types for all 14 commands and checks that
//   1. the handler never throws (it always returns { kind: 'error', text })
//   2. the message is English and does not expose a raw stack
//   3. things caught by pre-validation do not start the CLI (i.e. no charge)
//   4. the follow-up message passes the real V4 validation (assertV4RowAdmission)
// The point is to use the real validator; unit tests with only a fake agent miss the real-hardware bugs above.
//
// Usage: node tests/preflight-error-sweep.mjs

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const hostModules = join(root, 'reference/asar/node_modules/@deepseek-ai');

const load = (relative) => import(new URL(`file://${join(hostModules, relative).replace(/\\/g, '/')}`).href);
const loadLocal = (relative) => import(new URL(`file://${join(here, '..', relative).replace(/\\/g, '/')}`).href);

const format = await load('dsh-session-format-v3-to-v4/lib/index.js');
const { buildGensparkCommands, withFollowup } = await loadLocal('lib/commands.js');

let ok = 0;
let fail = 0;
const failures = [];
const check = (label, passed, detail = '') => {
  if (passed) {
    ok += 1;
  } else {
    fail += 1;
    failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
};

const admit = (row) => {
  try {
    format.assertV4RowAdmission(row);
    return null;
  } catch (error) {
    return error?.message ?? String(error);
  }
};

const settle = () => new Promise((done) => setTimeout(done, 0));
const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/;
const ENGLISH = /[A-Za-z]/;
const RAW_STACK = /\n\s+at\s|node:internal|ERR_[A-Z_]+/;

const FAKE_TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web',
    cli: { group: 'search' },
    parameters: { properties: { q: { type: 'string' } }, required: ['q'] },
  },
];

/** Build a fake runner per failure type. CLI calls are recorded in calls. */
function makeHarness(kind, calls, log) {
  const runner = {
    async runTool(toolName, toolArgs) {
      calls.push({ toolName, toolArgs });
      if (kind === 'throw') throw new Error('spawn EPERM (test)');
      if (kind === 'envelope') {
        return {
          code: 0,
          stdout: JSON.stringify({ status: 'error', message: 'rate limited', error_code: 'RATE_LIMIT' }),
          stderr: '',
          ok: false,
        };
      }
      if (kind === 'garbage') return { code: 1, stdout: '', stderr: '[ERROR] not logged in', ok: false };
      if (kind === 'timeout') return { code: null, stdout: '', stderr: '', ok: false, timedOut: true };
      return { code: 0, stdout: JSON.stringify({ status: 'ok', message: 'success', data: {} }), stderr: '', ok: true };
    },
    resolveEntry: () => 'C:\\fake\\@genspark\\cli\\dist\\index.js',
    resolveRuntime: () => ({ path: 'C:\\node.exe', source: 'auto' }),
  };
  const commands = buildGensparkCommands({
    getConfig: () => ({
      timeoutMs: 600000,
      maxOutputChars: 100000,
      promotedCategories: ['search', 'media'],
      writeMode: 'approve',
      commandFollowup: true,
    }),
    runner,
    catalog: { async load() { return { tools: FAKE_TOOLS }; } },
    log,
  });
  return commands;
}

const seen = [];
const agent = {
  session: { header: { cwd: process.cwd() } },
  followup(message) {
    seen.push(message);
  },
};
const invocation = (rawInput) => ({ rawInput, commandId: 'c1', attachments: [], signal: undefined, agent });

/** Run once and return the result and follow-up message. */
async function run(commands, name, input, calls, log) {
  const command = commands.find((item) => item.name === name);
  const before = seen.length;
  const beforeCalls = calls.length;
  const result = await command.handler(invocation(input));
  await settle();
  return {
    result,
    message: seen[before],
    cliCalls: calls.length - beforeCalls,
    logLines: log.lines.length,
  };
}

const makeLog = () => {
  const lines = [];
  const log = (line) => lines.push(String(line));
  log.lines = lines;
  return log;
};

/** Check all conditions an error result must satisfy. */
function checkError(label, run1, { expectCli = false } = {}) {
  const { result, message, cliCalls } = run1;
  const text = typeof result?.text === 'string' ? result.text : '';
  check(`${label}: {kind:'error'}`, result?.kind === 'error', `kind=${result?.kind}`);
  check(`${label}: message is English`, ENGLISH.test(text) && !JAPANESE.test(text), text.slice(0, 90));
  check(`${label}: does not expose a raw stack`, !RAW_STACK.test(text), text.slice(0, 90));
  check(`${label}: message is not empty`, text.trim().length > 0);
  const reason = message === undefined ? 'follow-up was not sent' : admit({ type: 'user/message', data: message });
  check(`${label}: follow-up passes V4 validation`, reason === null, reason ?? '');
  if (!expectCli) {
    check(`${label}: does not start the CLI (no charge)`, cliCalls === 0, `${cliCalls} times`);
  }
  return { text };
}

// ── 1. 14 commands × 3 failure types (no input / runner exception / error response) ──
console.log('1. Error paths for all 14 commands');
const names = makeHarness('ok', [], makeLog()).map((command) => command.name);
check('there are 14 commands', names.length === 14, names.join(' '));

for (const name of names) {
  // (a) No input (commands that need an argument are rejected here)
  {
    const calls = [];
    const log = makeLog();
    const commands = makeHarness('ok', calls, log);
    const out = await run(commands, name, '', calls, log);
    if (name === 'genspark') {
      // /genspark takes no argument (connection status), so this is not an error
      check(`${name}: runs without arguments`, out.result?.kind === 'success', `kind=${out.result?.kind}`);
    } else if (name === 'genspark-tools') {
      // /genspark-tools correctly lists all tools without arguments too
      check(`${name}: lists all tools without arguments`, out.result?.kind === 'success', `kind=${out.result?.kind}`);
    } else {
      checkError(`${name} (no input)`, out);
    }
  }

  // (b) The runner throws
  {
    const calls = [];
    const log = makeLog();
    const commands = makeHarness('throw', calls, log);
    const input = name === 'genspark-tools' ? '' : name === 'genspark-run' ? 'me' : 'test';
    const out = await run(commands, name, input, calls, log);
    if (name === 'genspark' || name === 'genspark-tools') {
      // /genspark swallows each item individually, and /genspark-tools uses only the catalog (no runner needed)
      check(`${name}: returns a result even when the runner throws`, typeof out.result?.kind === 'string', `kind=${out.result?.kind}`);
    } else {
      checkError(`${name} (runner exception)`, out, { expectCli: true });
    }
  }

  // (c) The runner returns an error response
  {
    const calls = [];
    const log = makeLog();
    const commands = makeHarness('envelope', calls, log);
    const input = name === 'genspark-tools' ? '' : name === 'genspark-run' ? 'me' : 'test';
    const out = await run(commands, name, input, calls, log);
    if (name === 'genspark' || name === 'genspark-tools') {
      check(`${name}: returns a result even on an error response`, typeof out.result?.kind === 'string', `kind=${out.result?.kind}`);
    } else {
      checkError(`${name} (error response)`, out, { expectCli: true });
    }
  }
}

// ── 2. Things caught by pre-validation do not start the CLI ────────────────────────
console.log('2. Pre-validation (the CLI is not started)');
for (const [name, input, why] of [
  ['genspark-crawl', 'This is a test. Tell me about the data leak that happened yesterday.', 'not a URL or a file'],
  ['genspark-summarize', 'This is a question, not a URL.', 'not a URL or a file'],
  ['genspark-run', 'web_search {"q":', 'broken JSON'],
  ['genspark-run', 'no_such_tool_xyz', 'nonexistent tool'],
  ['genspark-search', '   ', 'whitespace only'],
]) {
  const calls = [];
  const log = makeLog();
  const commands = makeHarness('ok', calls, log);
  const out = await run(commands, name, input, calls, log);
  checkError(`${name} (${why})`, out);
}

// ── 3. When the runner returns a timeout or uninterpretable output ─────────────────
console.log('3. Timeout and uninterpretable output');
for (const kind of ['timeout', 'garbage']) {
  for (const name of ['genspark-search', 'genspark-analyze-media', 'genspark-run']) {
    const calls = [];
    const log = makeLog();
    const commands = makeHarness(kind, calls, log);
    const input = name === 'genspark-run' ? 'me' : 'test';
    const out = await run(commands, name, input, calls, log);
    checkError(`${name} (${kind})`, out, { expectCli: true });
  }
}

// ── 4. Unexpected plugin-side conditions (broken getConfig / handler returns an invalid value) ──
console.log('4. Unexpected internal errors');
{
  const log = makeLog();
  const commands = buildGensparkCommands({
    getConfig: () => {
      throw new Error('failed to load the settings (test)');
    },
    runner: { async runTool() { throw new Error('should not be called'); }, resolveEntry: () => null, resolveRuntime: () => ({ path: '', source: '' }) },
    catalog: { async load() { return { tools: [] }; } },
    log,
  });
  for (const name of ['genspark', 'genspark-search', 'genspark-run']) {
    const before = seen.length;
    const result = await commands.find((item) => item.name === name).handler(invocation('test'));
    await settle();
    check(`${name}: does not throw even when getConfig is broken`, result?.kind === 'error' || result?.kind === 'success', `kind=${result?.kind}`);
    const message = seen[before];
    const reason = message === undefined ? null : admit({ type: 'user/message', data: message });
    check(`${name}: the follow-up also passes V4 validation`, reason === null, reason ?? '');
  }
  check('unexpected internal errors are logged', log.lines.some((line) => /failed to load the settings|an exception occurred|returned an invalid result/.test(line)), log.lines.slice(0, 2).join(' / '));
}
{
  const log = makeLog();
  const deps = { getConfig: () => ({ commandFollowup: true }), runner: {}, catalog: {}, log };
  // Check withFollowup's guards directly (exception → English error, invalid return value → English error)
  for (const [label, inner] of [
    ['synchronous throw', () => { throw new Error('internal error (test)'); }],
    ['asynchronous reject', async () => { throw new Error('async error (test)'); }],
    ['returns undefined', async () => undefined],
    ['object without kind', async () => ({ text: 'x' })],
    ['returns a string', async () => 'bad return value'],
  ]) {
    const guarded = withFollowup({ name: 'genspark-search', gsk: 'web_search', handler: inner }, deps);
    const before = seen.length;
    const result = await guarded(invocation('test'));
    await settle();
    const text = typeof result?.text === 'string' ? result.text : '';
    check(`unexpected (${label}): returns an English error without throwing`, result?.kind === 'error' && ENGLISH.test(text) && !JAPANESE.test(text) && !RAW_STACK.test(text), `${result?.kind} / ${text.slice(0, 70)}`);
    const message = seen[before];
    const reason = message === undefined ? 'follow-up was not sent' : admit({ type: 'user/message', data: message });
    check(`unexpected (${label}): the follow-up also passes V4 validation`, reason === null, reason ?? '');
  }
  check('unexpected internal errors are logged', log.lines.some((line) => /an exception occurred|returned an invalid result/.test(line)), log.lines.slice(0, 2).join(' / '));
}

console.log(`\nResult: ${ok} passed / ${fail} failed`);
if (fail > 0) {
  console.log('\nFailed checks:');
  for (const line of failures) console.log(`  ✘ ${line}`);
}
process.exitCode = fail === 0 ? 0 : 1;
