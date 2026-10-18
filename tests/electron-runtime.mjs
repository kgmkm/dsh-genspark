/**
 * DSH の実環境条件（親プロセスが Electron）での検証。
 *
 * 背景: DSH サーバーは Electron 上で動くため process.execPath は "DeepSeek Harness.exe"。
 * これをそのまま子プロセスのランタイムに使うと commander が Electron 用の argv 解釈に切り替わり
 * （node_modules/commander/lib/command.js:981-983, 1010-1018。ELECTRON_RUN_AS_NODE 起動時は
 * process.defaultApp が未設定なので argv.slice(1) がユーザー引数になる）
 *   error: unknown command '<...>/dist/index.js'
 * で落ちる（実機で観測）。対策として実 Node 実行ファイルを探索して使う。
 *
 * 実行（推奨 = 実際に Electron 上で走らせる）:
 *   $env:ELECTRON_RUN_AS_NODE='1'; & 'D:\deepseek\DeepSeek Harness.exe' tests/electron-runtime.mjs
 * 実行（素の Node。Electron 実行ファイルが分かる場合は壊れることを確認する）:
 *   node tests/electron-runtime.mjs
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRunner, resolveNodeRuntime } from '../lib/gsk-cli.js';
import { describeRun } from '../lib/result.js';

const onElectron = Boolean(process.versions?.electron);
console.log(`親プロセス: ${process.execPath}`);
console.log(`process.versions.electron: ${process.versions?.electron ?? '(なし = 素の Node)'}`);

const checks = [];
const record = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  console.log(`\n[${pass ? 'OK' : 'NG'}] ${name}\n  ${String(detail).replace(/\s+/g, ' ').slice(0, 400)}`);
};

// 1) ランタイム解決
const resolved = resolveNodeRuntime({ config: {}, env: process.env });
record(
  'ランタイム解決',
  !resolved.isElectron,
  `path=${resolved.path} / source=${resolved.source} / isElectron=${resolved.isElectron}`,
);

if (onElectron) {
  record(
    'Electron 実行ファイルが候補から除外されている',
    resolved.path !== process.execPath,
    `resolved=${resolved.path} / execPath=${process.execPath}`,
  );
}

// 2) 既定設定で me が通るか（以前は unknown command で落ちていた経路）
const config = { timeoutMs: 120000 };
const runner = createRunner({ getConfig: () => config });
console.log(`\nentry: ${runner.resolveEntry()}`);
console.log(`runner.resolveRuntime(): ${JSON.stringify(runner.resolveRuntime())}`);

const me = await runner.run(['--output', 'json', 'me'], { cwd: process.cwd(), timeoutMs: 60000 });
const described = describeRun(me, { tool: 'me', maxChars: 2000 });
record('me（アカウント取得）', described.ok, `code=${me.code} runtime=${me.runtime?.path} ${described.text}`);

// 3) カタログ（ls）も同じ経路で通るか
const ls = await runner.run(['--output', 'json', 'ls'], { cwd: process.cwd(), timeoutMs: 120000 });
const toolCount = Array.isArray(ls.value?.tools) ? ls.value.tools.length : 0;
record('ls（カタログ取得）', toolCount > 100, `code=${ls.code} tools=${toolCount} ${ls.stderr.trim()}`);

// 4) 昇格ツール（型付き）が DSH と同じ条件で通るか。
//    親の cwd を別ディレクトリにして「親子で cwd が違う」状況も同時に再現する
//    （実機で tmpDir='' が相対パスになり --args-file が ENOENT になった不具合の確認）。
const otherCwd = tmpdir();
const promotedRunner = createRunner({ getConfig: () => ({ ...config, tmpDir: '' }) });
const promoted = await promotedRunner.runTool('web_search', { q: 'DeepSeek Harness' }, {
  cwd: otherCwd,
  globalArgs: ['--output', 'json', '--no-input'],
  timeoutMs: 120000,
});
record(
  '昇格ツール経路（--args-file + cwd 不一致）',
  /"organic_results"|"result_type"|"status"\s*:\s*"ok"/.test(promoted.stdout ?? ''),
  `親 cwd=${process.cwd()} / 子 cwd=${otherCwd} / code=${promoted.code} / ${promoted.stderr.trim().slice(0, 120)}`,
);

// 5) 参考: Electron 実行ファイルを強制すると再現する（対策が効いている証拠）
const electronPath = process.env.DSH_ELECTRON_PATH ?? (onElectron ? process.execPath : '');
if (electronPath && existsSync(electronPath)) {
  const broken = await runner.run(['--output', 'json', 'me'], {
    cwd: process.cwd(),
    timeoutMs: 60000,
    runtimePath: electronPath,
  });
  const reproduced = !broken.ok && /unknown command/i.test(broken.stderr);
  record(
    '参考: Electron 実行ファイルを強制すると同じ症状を再現する',
    reproduced,
    `code=${broken.code} stderr=${broken.stderr.split('\n').slice(0, 2).join(' | ')}`,
  );
} else {
  console.log('\n[SKIP] Electron 実行ファイルが不明なため再現チェック（4）は省略');
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n=== ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`} / ${checks.length} チェック ===`);
if (!onElectron) {
  console.log('※親が素の Node のため、Electron 実機での確認は ELECTRON_RUN_AS_NODE=1 で再実行してください。');
}
process.exit(failed.length === 0 ? 0 : 1);
