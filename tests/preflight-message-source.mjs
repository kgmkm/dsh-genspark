// Preflight that pins the hand-off messages as passing the **real host session-format V4 validation**.
//
// Background (a bug that occurred on real hardware):
//   The `agent.followup` call that hands a command result to the model was sending
//   `source: { kind: 'plugin', plugin: 'dsh-genspark' }`, and the host rejected it with
//     "format v4 message requires a producer-owned source kind"
//   which failed the whole turn (the chat became unusable).
//   The V3 `kind: 'plugin'` wrapper has been removed, and the V4 canonical form is `kind: 'plugin:<plugin-name>'`.
//   Unit tests with a fake agent do not run the validator, so this bug was invisible.
//
// Here the messages the plugin actually sends are passed to the real `assertV4RowAdmission`
// (dsh-session-format-v3-to-v4) in both the `user/message` row form and the `agent/inbox/spliced` row form.
//
// Usage: node tests/preflight-message-source.mjs
// Requires: reference/asar/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4 (extracted)

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const hostModules = join(root, 'reference/asar/node_modules/@deepseek-ai');

const load = (relative) =>
  import(new URL(`file://${join(hostModules, relative).replace(/\\/g, '/')}`).href);
const loadLocal = (relative) =>
  import(new URL(`file://${join(here, '..', relative).replace(/\\/g, '/')}`).href);

const format = await load('dsh-session-format-v3-to-v4/lib/index.js');
const { buildGensparkCommands } = await loadLocal('lib/commands.js');

let ok = 0;
let fail = 0;
const check = (label, passed, detail = '') => {
  if (passed) {
    ok += 1;
    console.log(`  ✔ ${label}${detail === '' ? '' : ` — ${detail}`}`);
  } else {
    fail += 1;
    console.log(`  ✘ ${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
};

/** Pass a row through the real validator. Return the message if rejected (null when it passes). */
const admit = (row) => {
  try {
    format.assertV4RowAdmission(row);
    return null;
  } catch (error) {
    return error?.message ?? String(error);
  }
};

const settle = () => new Promise((done) => setTimeout(done, 0));

const FAKE_TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web',
    cli: { group: 'search' },
    parameters: { properties: { q: { type: 'string' } }, required: ['q'] },
  },
];

function makeCommands() {
  return buildGensparkCommands({
    getConfig: () => ({
      timeoutMs: 600000,
      maxOutputChars: 100000,
      promotedCategories: ['search', 'media'],
      writeMode: 'approve',
      commandFollowup: true,
    }),
    runner: {
      async runTool(toolName, toolArgs) {
        return {
          code: 0,
          stdout: JSON.stringify({ status: 'ok', message: 'success', data: { echo: toolArgs, tool: toolName } }),
          stderr: '',
          ok: true,
        };
      },
      resolveEntry: () => 'C:\\fake\\@genspark\\cli\\dist\\index.js',
      resolveRuntime: () => ({ path: 'C:\\node.exe', source: 'auto' }),
    },
    catalog: { async load() { return { tools: FAKE_TOOLS }; } },
  });
}

// ── 1. Confirm the real validator still rejects the V3 wrapper from the bug ────────
console.log('1. Real validator behaviour (reproducing the rejection seen on real hardware)');
const legacyMessage = {
  content: [{ type: 'text', text: 'test' }],
  source: { kind: 'plugin', plugin: 'dsh-genspark' },
};
const legacyUserRow = admit({ type: 'user/message', data: legacyMessage });
check(
  'V3 kind:"plugin" is rejected as a user/message row (reproduces the real-hardware bug)',
  typeof legacyUserRow === 'string' && /producer-owned source kind/.test(legacyUserRow),
  legacyUserRow ?? '(was not rejected)',
);
const legacyInboxRow = admit({
  type: 'agent/inbox/spliced',
  data: { target: 'next-turn', start: 0, inserted: [legacyMessage] },
});
check(
  'V3 kind:"plugin" is also rejected as an agent/inbox/spliced row',
  typeof legacyInboxRow === 'string' && /producer-owned source kind/.test(legacyInboxRow),
  legacyInboxRow ?? '(was not rejected)',
);

// ── 2. The hand-off messages of all 14 commands pass validation ────────────────────
console.log('\n2. Hand-off messages for all 14 commands (error path = no input)');
const commands = makeCommands();
const seen = [];
const agent = {
  session: { header: { cwd: process.cwd() } },
  followup(message) {
    seen.push(message);
  },
};
const invocation = (rawInput) => ({ rawInput, commandId: 'c1', attachments: [], signal: undefined, agent });

for (const command of commands) {
  const before = seen.length;
  await command.handler(invocation(''));
  await settle();
  const message = seen[before];
  if (message === undefined) {
    check(`follow-up message for /${command.name} is sent`, false, 'not sent');
    continue;
  }
  const reason =
    admit({ type: 'user/message', data: message }) ??
    admit({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [message] } });
  check(
    `follow-up message for /${command.name} passes V4 validation`,
    reason === null,
    reason === null ? `source=${JSON.stringify(message.source)}` : reason,
  );
}

// ── 3. Success-path messages also pass validation ──────────────────────────────────
console.log('\n3. Success path (the fake CLI returns ok)');
for (const [name, input] of [
  ['genspark-search', 'test'],
  ['genspark-crawl', 'https://example.com/'],
  ['genspark-analyze-media', 'https://example.com/photo.jpg'],
]) {
  const command = commands.find((item) => item.name === name);
  const before = seen.length;
  const result = await command.handler(invocation(input));
  await settle();
  const message = seen[before];
  const reason = message === undefined ? 'follow-up was not sent' : admit({ type: 'user/message', data: message });
  check(
    `follow-up message for /${name} (success) passes V4 validation`,
    result.kind === 'success' && reason === null,
    reason === null ? `status line=${/Status: (\S+)/.exec(message.content[0].text)?.[1]}` : reason,
  );
}

console.log(`\nResult: ${ok} passed / ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
