/**
 * 実 CLI に対する統合テスト（ログイン済み環境が必要）。
 *
 * 目的: 「プラグインのコード経路が本物の gsk と正しく噛み合うか」を、
 *       DSH ホスト無しで検証する。defineTool を素通しの関数に差し替えることで
 *       lib/tools.js の execute をそのまま実行する。
 *
 * 実行: node tests/integration.mjs
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

// 1) CLI エントリ解決
const entry = runner.resolveEntry();
record('CLI エントリ解決', Boolean(entry), entry ?? '(未検出)');
if (!entry) process.exit(1);

// 2) genspark_status（--version と me を実際に叩く）
const status = await byName.get('genspark_status').execute({}, exec);
record('genspark_status 実行', /CLI バージョン: \d+\.\d+\.\d+/.test(status), status.split('\n').slice(0, 3).join(' | '));

// 3) カタログ取得（302 ツール）
const catalogText = await byName.get('genspark_tools').execute({}, exec);
const total = /全 (\d+) ツール/.exec(catalogText)?.[1];
record('genspark_tools 要約', Number(total) > 200, `検出 ${total} ツール / グループ ${groupSummary(catalog.peek().tools).length}`);

// 4) 完全スキーマ表示
const full = await byName.get('genspark_tools').execute({ keyword: 'web_search', full: true }, exec);
record('genspark_tools full=true', /parameters \(args に渡す JSON のキー\)/.test(full), full.split('\n')[1]?.slice(0, 80));

// 5) 読み取り系ツールを実実行（web_search）
const search = await byName.get('genspark_run').execute({ tool: 'web_search', args: { q: 'DeepSeek Harness' } }, exec);
record('genspark_run: web_search', !/エラー|失敗|解釈できません/.test(search), search.replace(/\s+/g, ' ').slice(0, 120));

// 6) 未承認の副作用操作は拒否される（--no-input → exit 2 / サーバー未呼び出し）
const gated = await byName.get('genspark_run').execute({ tool: 'slack', args: { action: 'send', recipient: '#test', message: 'should not send' } }, exec);
record('未承認の副作用操作を拒否', /承認/.test(gated), gated.replace(/\s+/g, ' ').slice(0, 120));

// 7) 対話必須操作はカタログ判定で事前に弾く（プロセスを起動しない）
await catalog.load(runner, {});
const interactive = await byName.get('genspark_run').execute({ tool: 'x_post_tweet', args: { text: 'hi' } }, exec);
record('対話必須操作を事前拒否', /対話が必要|interactive_only/.test(interactive), interactive.slice(0, 80));

// 8) 存在しないツール名
const unknown = await byName.get('genspark_run').execute({ tool: 'no_such_tool_xyz', args: {} }, exec);
record('存在しないツールの扱い', typeof unknown === 'string' && unknown.length > 0, unknown.replace(/\s+/g, ' ').slice(0, 120));

// 9) 書き込みポリシーの解決
record('書き込みポリシー', resolveWritePolicy(config, true).flags[0] === '--yes', JSON.stringify(resolveWritePolicy(config, false).flags));

// 10) 親プロセスの cwd と子プロセスの cwd が違っても --args-file が解決できること
//     （DSH 実機で tmpDir='' が相対パスになり ENOENT になった不具合の回帰テスト。
//       親の cwd を別ディレクトリにして実行すると、修正前はここで失敗する）
const otherCwd = tmpdir();
const otherRunner = createRunner({ getConfig: () => ({ ...config, tmpDir: '' }) });
const mismatched = await otherRunner.runTool('me', {}, {
  cwd: otherCwd,
  globalArgs: ['--output', 'json', '--no-input'],
  timeoutMs: 60000,
});
record(
  '引数なしのツールに --args-file を付けない（親子で cwd が違っても動く）',
  /"email"\s*:/.test(mismatched.stdout ?? ''),
  `親 cwd=${process.cwd()} / 子 cwd=${otherCwd} / code=${mismatched.code} / ${String(mismatched.stderr ?? '').trim().slice(0, 80)}`,
);

const mismatchedArgs = await otherRunner.runTool('web_search', { q: 'DeepSeek Harness' }, {
  cwd: otherCwd,
  globalArgs: ['--output', 'json', '--no-input'],
  timeoutMs: 120000,
});
record(
  '親子で cwd が違っても --args-file の絶対パスが読める',
  /"organic_results"|"result_type"|"status"\s*:\s*"ok"/.test(mismatchedArgs.stdout ?? ''),
  `親 cwd=${process.cwd()} / 子 cwd=${otherCwd} / code=${mismatchedArgs.code} / ${String(mismatchedArgs.stderr ?? '').trim().slice(0, 80)}`,
);

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 成功 ===`);
process.exit(failed.length === 0 ? 0 : 1);
