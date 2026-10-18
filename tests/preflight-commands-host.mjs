// Preflight that actually registers this plugin's 14 command definitions with the real host
// dsh-commands (extracted from app.asar) and validates them.
//
// Purpose: contract violations in command names / descriptions / input.hint, or name collisions with
//          existing commands, **throw at register time**. If even one throws, that command does not
//          appear in the menu, so run the real host validator before a restart.
//          It also verifies that "profiles without the service still work" (optional dependency) and
//          that "disposing the fiber removes the commands".
//
// Usage: node tests/preflight-commands-host.mjs
// Requires: reference/asar/node_modules/@deepseek-ai/{cordis,dsh-commands} (extracted)
//           @deepseek-ai/dsh-llm is a minimal stub containing callConfigEquals (inside reference/asar)

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const hostModules = join(root, 'reference/asar/node_modules/@deepseek-ai');

const load = (relative) =>
  import(new URL(`file://${join(hostModules, relative).replace(/\\/g, '/')}`).href);

const cordis = await load('cordis/lib/index.js');
const commandsModule = await load('dsh-commands/lib/index.js');
const { buildGensparkCommands } = await import(
  new URL(`file://${join(here, '..', 'lib', 'commands.js').replace(/\\/g, '/')}`).href
);

const log = { info() {}, warn() {}, error() {}, debug() {} };
const settle = () => new Promise((done) => setTimeout(done, 50));

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

// Stubs used to verify that registration never launches the CLI
const calls = [];
const runner = {
  async runTool(gsk, args, opts) {
    calls.push({ gsk, args, opts });
    return { code: 0, ok: true, envelope: { status: 'ok', data: {} }, stderr: '' };
  },
  resolveRuntime: () => ({ path: 'node', source: 'test' }),
};
const catalog = {
  async load() {
    calls.push({ gsk: '(catalog)' });
    return { tools: [], features: {} };
  },
};

const config = {
  promotedCategories: ['search', 'media'],
  timeoutMs: 300000,
  maxChars: 4000,
  debug: false,
};
const definitions = buildGensparkCommands({ getConfig: () => config, runner, catalog, log });

console.log(`Commands registered with the real host dsh-commands: ${definitions.length}\n`);

// --- 1. Actually mount the host service --------------------------------------------
const app = new cordis.Context();
const serviceFiber = app.plugin(commandsModule.default ?? commandsModule.CommandRuntime);
await settle();
const service = app.commands;
check('commands service is mounted', typeof service?.register === 'function', service?.constructor?.name);

// --- 2. Put other plugins' commands that already appear in the menu first (collision premise) ---
const HOST_NAMES = ['compact', 'permission', 'model', 'export', 'acp', 'acp-cache', 'feedback', 'goal', 'plan', 'file'];
for (const name of HOST_NAMES) {
  service.register({ name, description: `host ${name}`, handler: async () => ({ kind: 'success' }) });
}
check('registered 10 existing commands', service.list(undefined).length === HOST_NAMES.length);

// --- 3. Pass the 14 commands through the host validator ----------------------------
for (const definition of definitions) {
  try {
    const disposer = service.register(definition);
    check(`registered ${definition.name}`, typeof disposer === 'function');
  } catch (error) {
    check(`registered ${definition.name}`, false, error?.message ?? String(error));
  }
}

const listed = service.list(undefined).map((descriptor) => descriptor.name);
const expected = definitions.map((definition) => definition.name).sort();
const mine = listed.filter((name) => !HOST_NAMES.includes(name));
check(
  'post-registration list matches the 14 commands',
  JSON.stringify(mine) === JSON.stringify(expected),
  mine.join(', '),
);

// --- 4. Are they visible to the host's own parser and lookup? ----------------------
for (const definition of definitions) {
  const parsed = commandsModule.parseCommand(`/${definition.name} test input`);
  check(`/${definition.name} is parsed by the host parser`, parsed?.name === definition.name, JSON.stringify(parsed));

  const found = service.find(undefined, definition.name);
  check(
    'find() returns description and hint',
    found?.description === definition.description && found?.input?.hint === definition.input?.hint,
    found?.input?.hint ?? '(no hint)',
  );
}

// --- 5. The host rejects duplicate registration (confirming our names are unique) ---
try {
  service.register(definitions[0]);
  check('host rejects a duplicate registration', false, 'was not rejected');
} catch (error) {
  check('host rejects a duplicate registration', /already registered/.test(String(error?.message)), String(error?.message).slice(0, 60));
}

// --- 6. The host validator rejects invalid definitions (proof that this check works) ---
const invalid = [
  ['name with uppercase', { name: 'Genspark-Bad', description: 'x', handler: async () => ({ kind: 'success' }) }],
  ['empty hint', { name: 'genspark-bad', description: 'x', input: { hint: '   ' }, handler: async () => ({ kind: 'success' }) }],
  ['handler is not a function', { name: 'genspark-bad2', description: 'x', handler: 'nope' }],
];
for (const [label, definition] of invalid) {
  try {
    service.register(definition);
    check(`rejects invalid definition: ${label}`, false, 'was not rejected');
  } catch (error) {
    check(`rejects invalid definition: ${label}`, true, String(error?.message).slice(0, 70));
  }
}

// --- 7. Registration does not launch the CLI (no side effects) ---------------------
check('registration alone does not call the CLI', calls.length === 0, `runner calls: ${calls.length}`);

// --- 8. The same optional-dependency + dispose path as index.js -------------------
const app2 = new cordis.Context();
const serviceFiber2 = app2.plugin(commandsModule.default ?? commandsModule.CommandRuntime);
await settle();

let fired = 0;
const commandFiber = app2.inject(['commands'], (inner) => {
  fired += 1;
  for (const definition of definitions) inner.commands.register(definition);
});
await settle();
check('ctx.inject(["commands"]) callback ran', fired === 1, `fired=${fired}`);
const insideCount = app2.commands.list(undefined).length;
check('14 commands are registered via inject', insideCount === definitions.length, `${insideCount} items`);

commandFiber.dispose();
await settle();
const afterDispose = app2.commands.list(undefined).length;
check('fiber.dispose() removes the commands', afterDispose === 0, `${afterDispose} items`);

// --- 9. Nothing happens in profiles without the commands service (optional dependency) ---
const app3 = new cordis.Context();
let fired3 = 0;
const fiber3 = app3.inject(['commands'], () => {
  fired3 += 1;
});
await settle();
check('the callback does not run without the service', fired3 === 0, `fired=${fired3}`);
check('the Context stays healthy without the service', app3.get('commands') === undefined);
fiber3.dispose();
serviceFiber.dispose();
serviceFiber2.dispose();

console.log(`\nResult: ${ok} passed / ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
