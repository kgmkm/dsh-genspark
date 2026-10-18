/**
 * Real-CLI integration test for the host commands (the 14 commands run from the `+` menu / `/`).
 *
 * Run:
 *   node tests/commands-integration.mjs                  … read-only only (almost free)
 *   node tests/commands-integration.mjs --with-generation … also runs image generation and verifies saving to genspark-out (spends credits)
 *
 * Commands "do not create model messages", so here the handler is called directly to validate the
 * CommandResult ({kind, text}) and the actual CLI call results.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createCatalogCache } from '../lib/catalog.js';
import { createRunner } from '../lib/gsk-cli.js';
import { buildGensparkCommands } from '../lib/commands.js';

const argv = process.argv.slice(2);
const withGeneration = argv.includes('--with-generation');

const cwd = process.cwd();
const config = {
  timeoutMs: 600000,
  maxOutputChars: 20000,
  writeMode: 'approve',
  promotedCategories: ['search', 'media'],
  debug: false,
};
const runner = createRunner({ getConfig: () => config });
const catalog = createCatalogCache({ getConfig: () => config, log: () => {} });
const commands = buildGensparkCommands({
  getConfig: () => config,
  runner,
  catalog,
  log: (message) => console.log(message),
});
const byName = new Map(commands.map((command) => [command.name, command]));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const flat = (text) => String(text).replace(/\s+/g, ' ').slice(0, 160);
const invoke = (name, rawInput) => {
  const command = byName.get(name);
  if (!command) throw new Error(`command ${name} is not registered`);
  return command.handler({ agent: { session: { header: { cwd } } }, rawInput, signal: undefined });
};

if (!runner.resolveEntry()) {
  console.error('CLI entry not found (npm install -g @genspark/cli is required)');
  process.exit(1);
}

// 1) Number of registered commands
record('Number of registered commands', commands.length === 14, `${commands.length} items: ${commands.map((c) => c.name).join(', ')}`);

// 2) /genspark (no arguments; status display)
const status = await invoke('genspark', '');
record(
  '/genspark (status display)',
  status.kind === 'success' && /CLI/.test(status.text) && /Promoted tools:/.test(status.text) && /genspark-search/.test(status.text),
  flat(status.text),
);

// 3) /genspark-tools (group overview → full schema when narrowed to a single match)
const groups = await invoke('genspark-tools', '');
record('/genspark-tools (group overview)', groups.kind === 'success' && /tool catalog:/.test(groups.text), flat(groups.text));
const oneTool = await invoke('genspark-tools', 'crawler');
record(
  '/genspark-tools crawler (full schema)',
  oneTool.kind === 'success' && /crawler/.test(oneTool.text) && /url/.test(oneTool.text) && /Example:/.test(oneTool.text),
  flat(oneTool.text),
);

// 4) /genspark-run (read-only execution)
const me = await invoke('genspark-run', 'me');
record('/genspark-run me', me.kind === 'success' && /backorz@gmail\.com|plan/i.test(me.text), flat(me.text));

// 5) /genspark-run pre-validation rejections (does not launch the CLI)
const broken = await invoke('genspark-run', 'web_search {"q":');
record('Rejects broken JSON', broken.kind === 'error' && /JSON/.test(broken.text), flat(broken.text));
const unknown = await invoke('genspark-run', 'no_such_tool_xyz');
record('Rejects a nonexistent tool', unknown.kind === 'error' && /has no tool named/.test(unknown.text), flat(unknown.text));

const full = await catalog.load(runner, { cwd });
const interactive = (full.tools ?? []).find((tool) => tool.cli?.interactive_only);
const confirming = (full.tools ?? []).find((tool) => tool.cli?.requires_confirmation && !tool.cli?.interactive_only);
if (interactive) {
  const blocked = await invoke('genspark-run', interactive.name);
  record(`Rejects interactive-only (${interactive.name})`, blocked.kind === 'error' && /requires interactive input/.test(blocked.text), flat(blocked.text));
} else {
  record('Rejects interactive-only', false, 'no interactive_only tool found');
}
if (confirming) {
  const blocked = await invoke('genspark-run', confirming.name);
  record(`Rejects confirmation-required (${confirming.name})`, blocked.kind === 'error' && /requires confirmation/.test(blocked.text), flat(blocked.text));
} else {
  record('Rejects confirmation-required', false, 'no requires_confirmation tool found');
}

// 6) Input validation for promoted commands
const emptySearch = await invoke('genspark-search', '');
record('Empty input errors without starting the CLI', emptySearch.kind === 'error' && /Input is required/.test(emptySearch.text), flat(emptySearch.text));

// 7) Real search (results are formatted for humans, no raw JSON)
const search = await invoke('genspark-search', 'DeepSeek Harness plugin');
record(
  '/genspark-search (real search, formatted)',
  search.kind === 'success' && /items/.test(search.text) && /https?:\/\//.test(search.text) && !/\{"[a-z_]+":/.test(search.text),
  flat(search.text),
);

// 8) analyze-media (media analysis) — real run on a sample image (read-only)
const visionImage = await invoke('genspark-analyze-media', 'D:\\Documents\\deepseek-harness\\default-workspace\\genspark-out\\test_cat.jpg');
record('/genspark-analyze-media image', visionImage.kind === 'success' && /cat|analysis/i.test(visionImage.text), flat(visionImage.text));

// 9) Generation command (optional; spends credits)
if (withGeneration) {
  const outDir = join(cwd, 'genspark-out');
  const before = existsSync(outDir) ? readdirSync(outDir).length : 0;
  const image = await invoke('genspark-image', 'a red cube on a white background');
  const after = existsSync(outDir) ? readdirSync(outDir).length : 0;
  const newest = existsSync(outDir)
    ? readdirSync(outDir)
        .map((file) => join(outDir, file))
        .filter((file) => statSync(file).isFile())
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
    : undefined;
  const size = newest ? statSync(newest).size : 0;
  record(
    '/genspark-image (generation + save to genspark-out)',
    image.kind === 'success' && after > before && size > 1000 && /Saved file:/.test(image.text),
    `${newest ?? '(nothing saved)'} (${size} bytes)`,
  );
} else {
  console.log('ℹ Skipping the real generation-command run (run with --with-generation)');
}

// 10) Early return for long-running commands (shortens the input-field freeze)
//     The host keeps the composer frozen in the submitting transaction until the command completes,
//     so after commandInlineWaitMs it returns "running now" and delivers the result to chat via the follow-up.
const seen = [];
const followupAgent = {
  session: { header: { cwd } },
  followup(message) {
    seen.push(message);
  },
};
const waitForFollowup = async (timeoutMs) => {
  const started = Date.now();
  while (seen.length === 0 && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};
config.commandInlineWaitMs = 1;
const early = await byName
  .get('genspark-run')
  .handler({ agent: followupAgent, rawInput: 'me', signal: undefined });
config.commandInlineWaitMs = 2500;
await waitForFollowup(30000);
const followupText = seen[0]?.content?.[0]?.text ?? '';
record(
  'Early return (the result arrives via follow-up)',
  early.kind === 'success' &&
    /The result will arrive in chat afterwards/.test(early.text) &&
    seen.length === 1 &&
    /Status: success/.test(followupText) &&
    /backorz@gmail\.com|plan/i.test(followupText),
  `${flat(early.text)} / follow-ups: ${seen.length}: ${flat(followupText)}`,
);

const failed = results.filter((entry) => !entry.ok);
console.log(`\n== ${results.length - failed.length}/${results.length} passed ==`);
if (failed.length > 0) {
  console.log('Failed: ' + failed.map((entry) => entry.name).join(', '));
  process.exit(1);
}
