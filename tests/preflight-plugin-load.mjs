// Preflight that lays out the shipped file set (package.json "files") in a temporary directory,
// places the host-provided modules (@deepseek-ai/dsh-tools etc.) next to it, and **actually loads index.js**.
//
// Purpose: if apply() throws after a restart, all tools and all 14 commands are lost at once.
//          This preflight detects that "failure at load time" with plain Node, before DSH is restarted.
//          It also fails here if anything is missing from "files" (i.e. the distribution is incomplete).
//
// Usage: node tests/preflight-plugin-load.mjs [--with-cli]
//        With --with-cli, genspark_status is executed once against the real CLI and the displayed lines are checked.
// Requires: reference/asar/node_modules/@deepseek-ai/* (extracted with probe/asar-extract.mjs)
//           schemastery is borrowed from the desktop profile's node_modules.

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, '..');
const root = resolve(pluginDir, '..');
const hostModules = join(root, 'reference/asar/node_modules/@deepseek-ai');
const profileModules = 'C:\\Users\\narukami\\.dsh\\profiles\\desktop\\node_modules\\@deepseek-ai';
const withCli = process.argv.includes('--with-cli');

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

// --- 1. Place the shipped artifacts in a temporary directory -----------------------
const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
const temp = mkdtempSync(join(tmpdir(), 'dsh-genspark-load-'));
console.log(`Temporary directory: ${temp}\n`);

for (const entry of manifest.files ?? []) {
  const source = join(pluginDir, entry);
  if (!existsSync(source)) {
    check(`files entry ${entry} exists`, false, 'not found');
    continue;
  }
  cpSync(source, join(temp, entry), { recursive: true });
}
check(
  `placed package.json files (${(manifest.files ?? []).join(', ')})`,
  (manifest.files ?? []).every((entry) => existsSync(join(temp, entry))),
);

// Place the host-provided modules as node_modules next to it (DSH itself resolves them from the host)
const vendorDir = join(temp, 'node_modules/@deepseek-ai');
cpSync(hostModules, vendorDir, { recursive: true, filter: (src) => !src.includes('dsh-client') });
for (const extra of ['schemastery', 'cosmokit']) {
  const from = join(profileModules, extra);
  if (existsSync(from)) cpSync(from, join(vendorDir, extra), { recursive: true });
}
check('placed host-provided modules under node_modules', existsSync(join(vendorDir, 'dsh-tools/lib/index.js')));

// --- 2. Actually import index.js ----------------------------------------------------
let mod;
try {
  mod = await import(pathToFileURL(join(temp, 'index.js')).href);
  check('loaded index.js (does not throw at import)', true);
} catch (error) {
  check('load index.js', false, `${error?.constructor?.name}: ${error?.message}`);
  console.log(`\nResult: ${ok} passed / ${fail} failed`);
  rmSync(temp, { recursive: true, force: true });
  process.exit(1);
}

check('export const name', mod.name === 'dsh-genspark', String(mod.name));
check('export const inject includes tools', Array.isArray(mod.inject) && mod.inject.includes('tools'), JSON.stringify(mod.inject));
check('export function apply', typeof mod.apply === 'function');
check(
  'Config (schemastery) resolved',
  mod.Config !== undefined && mod.config === mod.Config,
  mod.Config === undefined ? 'schemastery unresolved → runs with the raw config' : 'resolved',
);

// --- 3. Run apply() against a fake host ---------------------------------------------
function makeHost() {
  const tools = [];
  const commands = [];
  const logs = { info: [], warn: [], error: [], debug: [] };
  const disposed = { tools: 0, commands: 0, effect: 0 };
  const logger = {};
  for (const level of Object.keys(logs)) logger[level] = (message) => { logs[level].push(String(message)); };

  const innerTools = { tools: { register: (tool) => tools.push(tool) }, logger };
  const innerCommands = { commands: { register: (command) => commands.push(command) }, logger };

  // Keep the teardown registered via ctx.effect so the test can invoke it
  let teardown = () => { disposed.effect += 1; };

  const ctx = {
    logger,
    plugin: (definition) => {
      definition.apply(innerTools);
      return { dispose: () => { disposed.tools += 1; } };
    },
    inject: (deps, callback) => {
      if (Array.isArray(deps) && deps.includes('commands')) callback(innerCommands);
      return { dispose: () => { disposed.commands += 1; } };
    },
    effect: (fn) => {
      const returned = fn();
      teardown = () => {
        disposed.effect += 1;
        if (typeof returned === 'function') returned();
      };
      return teardown;
    },
  };
  return { ctx, tools, commands, logs, disposed, teardown: () => teardown() };
}

const host = makeHost();
let threw = null;
try {
  mod.apply(host.ctx, { promotedCategories: ['search', 'media'], commands: true, timeoutMs: 300000, maxChars: 100000 });
} catch (error) {
  threw = error;
}
check('apply() does not throw', threw === null, threw === null ? '' : String(threw?.message));

const toolNames = host.tools.map((tool) => tool.name).sort();
const commandNames = host.commands.map((command) => command.name).sort();
check('registers 14 tools', host.tools.length === 14, `${host.tools.length} items: ${toolNames.join(', ')}`);
check(
  'includes the 3 general-purpose tools',
  ['genspark_run', 'genspark_status', 'genspark_tools'].every((name) => toolNames.includes(name)),
);
check(
  'includes the 10 promoted tools',
  [
    'genspark_web_search',
    'genspark_image_search',
    'genspark_crawl',
    'genspark_scholar_search',
    'genspark_maps_search',
    'genspark_summarize_document',
    'genspark_generate_image',
    'genspark_generate_video',
    'genspark_generate_audio',
    'genspark_analyze_media',
  ].every((name) => toolNames.includes(name)),
);
check('registers 14 commands', host.commands.length === 14, `${host.commands.length} items`);
check(
  'registered tools are defineTool products (have parameters)',
  host.tools.every((tool) => typeof tool.execute === 'function' && typeof tool.parameters === 'object'),
);
check(
  'registered commands satisfy the host contract',
  host.commands.every(
    (command) =>
      /^[a-z][a-z0-9_-]*$/.test(command.name) &&
      typeof command.description === 'string' &&
      command.description.length > 0 &&
      typeof command.handler === 'function' &&
      (command.input === undefined || (typeof command.input.hint === 'string' && command.input.hint.trim().length > 0)),
  ),
);
check(
  'registration result appears in the info log',
  host.logs.info.some((line) => line.includes('commands: registered 14 commands')),
  host.logs.info.find((line) => line.includes('commands:')) ?? '(none)',
);

// --- 4. Switching via settings ------------------------------------------------------
const noCommands = makeHost();
mod.apply(noCommands.ctx, { promotedCategories: ['search', 'media'], commands: false });
check('commands=false registers 0 commands', noCommands.commands.length === 0, `${noCommands.commands.length} items`);
check('tools stay at 14 with commands=false', noCommands.tools.length === 14, `${noCommands.tools.length} items`);

const searchOnly = makeHost();
mod.apply(searchOnly.ctx, { promotedCategories: ['search'], commands: true });
check('promotedCategories=["search"] registers 10 commands', searchOnly.commands.length === 10, `${searchOnly.commands.length} items`);
check('promotedCategories=["search"] registers 10 tools', searchOnly.tools.length === 10, `${searchOnly.tools.length} items`);

const disabled = makeHost();
mod.apply(disabled.ctx, { enabled: false });
check('enabled=false registers nothing', disabled.tools.length === 0 && disabled.commands.length === 0);

// --- 5. Teardown (ctx.effect) unregisters both --------------------------------------
const teardownHost = makeHost();
mod.apply(teardownHost.ctx, { promotedCategories: ['search', 'media'], commands: true });
teardownHost.teardown(); // Invoke the teardown registered via ctx.effect (runs when DSH exits)
check('teardown unregisters both tools and commands', teardownHost.disposed.tools >= 1 && teardownHost.disposed.commands >= 1, JSON.stringify(teardownHost.disposed));

// --- 6. Optional: run genspark_status once against the real CLI ---------------------
if (withCli) {
  const status = host.tools.find((tool) => tool.name === 'genspark_status');
  try {
    const text = await status.execute({}, { agent: { session: { header: { cwd: root } } } });
    const lines = String(text).split('\n');
    console.log('\n  genspark_status output:');
    for (const line of lines) console.log(`    ${line}`);
    check('real CLI status includes a "Commands:" line', lines.some((line) => line.startsWith('Commands: registered 14 commands')));
  } catch (error) {
    check('real CLI status execution', false, String(error?.message));
  }
}

rmSync(temp, { recursive: true, force: true });
console.log(`\nResult: ${ok} passed / ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
