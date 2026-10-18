/**
 * Integration test against the real CLI (requires a logged-in environment).
 *
 * Purpose: verify "does the plugin's code path mesh correctly with the real gsk" without a DSH host.
 *          By replacing defineTool with an identity function, lib/tools.js execute runs as-is.
 *
 * Run: node tests/integration.mjs
 */
import { tmpdir } from 'node:os';
import { createCatalogCache, groupSummary } from '../lib/catalog.js';
import { createRunner } from '../lib/gsk-cli.js';
import { buildGensparkTools, resolveWritePolicy } from '../lib/tools.js';

const cwd = process.cwd();
const config = { timeoutMs: 300000, maxOutputChars: 20000, writeMode: 'approve' };
const runner = createRunner({ getConfig: () => config });
const catalog = createCatalogCache({ getConfig: () => config, log: (m) => console.log(m) });
const tools = buildGensparkTools({ defineTool: (spec) => spec, getConfig: () => config, runner, catalog, log: (m) => console.log(m) });
const byName = new Map(tools.map((t) => [t.name, t]));
const exec = { agent: { session: { header: { cwd } } }, signal: undefined };

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}
// Plugin-produced error output starts with one of these prefixes; successful output starts with data.
const ERROR_OUTPUT = /^(?:Genspark API error|Could not|Execution failed|An unexpected error|The argument names do not match)/;
const failedText = (text) => ERROR_OUTPUT.test(String(text));

// 1) CLI entry resolution
const entry = runner.resolveEntry();
record('CLI entry resolution', Boolean(entry), entry ?? '(not found)');
if (!entry) process.exit(1);

// 2) genspark_status (actually calls --version and me)
const status = await byName.get('genspark_status').execute({}, exec);
record('genspark_status execution', /CLI version: \d+\.\d+\.\d+/.test(status), status.split('\n').slice(0, 3).join(' | '));

// 3) Catalog fetch (302 tools)
const catalogText = await byName.get('genspark_tools').execute({}, exec);
const total = /catalog: (\d+) tools in total/.exec(catalogText)?.[1];
record('genspark_tools summary', Number(total) > 200, `detected ${total} tools / ${groupSummary(catalog.peek().tools).length} groups`);

// 4) Full schema display
const full = await byName.get('genspark_tools').execute({ keyword: 'web_search', full: true }, exec);
record('genspark_tools full=true', /parameters \(keys of the JSON passed in args\)/.test(full), full.split('\n')[1]?.slice(0, 80));

// 5) Actually run a read-only tool (web_search)
const search = await byName.get('genspark_run').execute({ tool: 'web_search', args: { q: 'DeepSeek Harness' } }, exec);
record('genspark_run: web_search', !failedText(search), search.replace(/\s+/g, ' ').slice(0, 120));

// 6) Unapproved side-effecting operations are rejected (--no-input → exit 2 / no server call)
const gated = await byName.get('genspark_run').execute({ tool: 'slack', args: { action: 'send', recipient: '#test', message: 'should not send' } }, exec);
record('Rejects an unapproved side-effecting operation', /requires confirmation/.test(gated), gated.replace(/\s+/g, ' ').slice(0, 120));

// 7) Interactive-only operations are rejected up front by catalog inspection (does not start a process)
await catalog.load(runner, {});
const interactive = await byName.get('genspark_run').execute({ tool: 'x_post_tweet', args: { text: 'hi' } }, exec);
record('Rejects interactive-only operations up front', /requires interaction|interactive_only/.test(interactive), interactive.slice(0, 80));

// 8) Nonexistent tool name
const unknown = await byName.get('genspark_run').execute({ tool: 'no_such_tool_xyz', args: {} }, exec);
record('Handling of a nonexistent tool', typeof unknown === 'string' && unknown.length > 0, unknown.replace(/\s+/g, ' ').slice(0, 120));

// 9) Write-policy resolution
record('Write policy resolution', resolveWritePolicy(config, true).flags[0] === '--yes', JSON.stringify(resolveWritePolicy(config, false).flags));

// 10) --args-file resolves even when the parent and child process cwds differ
//     (regression test for the real-hardware bug where tmpDir='' became a relative path and caused ENOENT.
//      Running with the parent cwd set to another directory fails here before the fix)
const otherCwd = tmpdir();
const otherRunner = createRunner({ getConfig: () => ({ ...config, tmpDir: '' }) });
const mismatched = await otherRunner.runTool('me', {}, {
  cwd: otherCwd,
  globalArgs: ['--output', 'json', '--no-input'],
  timeoutMs: 60000,
});
record(
  'No --args-file for a tool without arguments (works even when parent and child cwd differ)',
  /"email"\s*:/.test(mismatched.stdout ?? ''),
  `parent cwd=${process.cwd()} / child cwd=${otherCwd} / code=${mismatched.code} / ${String(mismatched.stderr ?? '').trim().slice(0, 80)}`,
);

const mismatchedArgs = await otherRunner.runTool('web_search', { q: 'DeepSeek Harness' }, {
  cwd: otherCwd,
  globalArgs: ['--output', 'json', '--no-input'],
  timeoutMs: 120000,
});
record(
  'The absolute --args-file path is readable even when parent and child cwd differ',
  /"organic_results"|"result_type"|"status"\s*:\s*"ok"/.test(mismatchedArgs.stdout ?? ''),
  `parent cwd=${process.cwd()} / child cwd=${otherCwd} / code=${mismatchedArgs.code} / ${String(mismatchedArgs.stderr ?? '').trim().slice(0, 80)}`,
);

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
process.exit(failed.length === 0 ? 0 : 1);
