// 出荷するファイル一式（package.json の files）を一時ディレクトリに配置し、
// ホスト提供モジュール（@deepseek-ai/dsh-tools など）を横に置いて **index.js を実際に読み込む**
// プリフライト。
//
// 目的: 再起動後に apply() が throw すると、ツール 23 件もコマンド 13 件も丸ごと失われる。
//       その「読み込み時の失敗」を、DSH を再起動する前に素の Node で検出する。
//       ついでに files に漏れがあれば（＝配布物が不完全なら）ここで落ちる。
//
// 使い方: node tests/preflight-plugin-load.mjs [--with-cli]
//         --with-cli を付けると genspark_status を実 CLI で 1 回だけ実行して表示行まで確認する。
// 前提  : reference/asar/node_modules/@deepseek-ai/*（probe/asar-extract.mjs で抽出済み）
//         schemastery は desktop プロファイルの node_modules から借りる。

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

// --- 1. 出荷物を一時ディレクトリへ配置 --------------------------------------------
const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
const temp = mkdtempSync(join(tmpdir(), 'dsh-genspark-load-'));
console.log(`一時ディレクトリ: ${temp}\n`);

for (const entry of manifest.files ?? []) {
  const source = join(pluginDir, entry);
  if (!existsSync(source)) {
    check(`files の ${entry} が存在する`, false, '見つからない');
    continue;
  }
  cpSync(source, join(temp, entry), { recursive: true });
}
check(
  `package.json の files（${(manifest.files ?? []).join(', ')}）を配置`,
  (manifest.files ?? []).every((entry) => existsSync(join(temp, entry))),
);

// ホスト提供モジュールを node_modules として横に置く（DSH 本体では host が解決する）
const vendorDir = join(temp, 'node_modules/@deepseek-ai');
cpSync(hostModules, vendorDir, { recursive: true, filter: (src) => !src.includes('dsh-client') });
for (const extra of ['schemastery', 'cosmokit']) {
  const from = join(profileModules, extra);
  if (existsSync(from)) cpSync(from, join(vendorDir, extra), { recursive: true });
}
check('ホスト提供モジュールを node_modules に配置', existsSync(join(vendorDir, 'dsh-tools/lib/index.js')));

// --- 2. index.js を実際に読み込む -------------------------------------------------
let mod;
try {
  mod = await import(pathToFileURL(join(temp, 'index.js')).href);
  check('index.js を読み込めた（import 時に throw しない）', true);
} catch (error) {
  check('index.js を読み込めた', false, `${error?.constructor?.name}: ${error?.message}`);
  console.log(`\n結果: 成功 ${ok} / 失敗 ${fail}`);
  rmSync(temp, { recursive: true, force: true });
  process.exit(1);
}

check('export const name', mod.name === 'dsh-genspark', String(mod.name));
check('export const inject に tools', Array.isArray(mod.inject) && mod.inject.includes('tools'), JSON.stringify(mod.inject));
check('export function apply', typeof mod.apply === 'function');
check(
  'Config（schemastery）が解決できた',
  mod.Config !== undefined && mod.config === mod.Config,
  mod.Config === undefined ? 'schemastery 未解決 → 生 config で動作する' : '解決済み',
);

// --- 3. 擬似ホストで apply() を走らせる -------------------------------------------
function makeHost() {
  const tools = [];
  const commands = [];
  const logs = { info: [], warn: [], error: [], debug: [] };
  const disposed = { tools: 0, commands: 0, effect: 0 };
  const logger = {};
  for (const level of Object.keys(logs)) logger[level] = (message) => { logs[level].push(String(message)); };

  const innerTools = { tools: { register: (tool) => tools.push(tool) }, logger };
  const innerCommands = { commands: { register: (command) => commands.push(command) }, logger };

  // apply() が ctx.effect で登録する後始末を、テストから呼べるように保持する
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
check('apply() が throw しない', threw === null, threw === null ? '' : String(threw?.message));

const toolNames = host.tools.map((tool) => tool.name).sort();
const commandNames = host.commands.map((command) => command.name).sort();
check('ツール 13 件を登録', host.tools.length === 13, `${host.tools.length} 件: ${toolNames.join(', ')}`);
check(
  '汎用 3 ツールが含まれる',
  ['genspark_run', 'genspark_status', 'genspark_tools'].every((name) => toolNames.includes(name)),
);
check(
  '昇格ツール 10 件が含まれる',
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
    'genspark_vision',
  ].every((name) => toolNames.includes(name)),
);
check('コマンド 13 件を登録', host.commands.length === 13, `${host.commands.length} 件`);
check(
  '登録したツールが defineTool の産物（parameters を持つ）',
  host.tools.every((tool) => typeof tool.execute === 'function' && typeof tool.parameters === 'object'),
);
check(
  '登録したコマンドがホスト契約を満たす',
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
  '登録結果が info ログに出る',
  host.logs.info.some((line) => line.includes('コマンド 13 件を登録しました')),
  host.logs.info.find((line) => line.includes('コマンド')) ?? '(該当なし)',
);

// --- 4. 設定による切り替え --------------------------------------------------------
const noCommands = makeHost();
mod.apply(noCommands.ctx, { promotedCategories: ['search', 'media'], commands: false });
check('commands=false でコマンド 0 件', noCommands.commands.length === 0, `${noCommands.commands.length} 件`);
check('commands=false でもツールは 13 件', noCommands.tools.length === 13, `${noCommands.tools.length} 件`);

const searchOnly = makeHost();
mod.apply(searchOnly.ctx, { promotedCategories: ['search'], commands: true });
check('promotedCategories=["search"] でコマンド 9 件', searchOnly.commands.length === 9, `${searchOnly.commands.length} 件`);
check('promotedCategories=["search"] でツール 9 件', searchOnly.tools.length === 9, `${searchOnly.tools.length} 件`);

const disabled = makeHost();
mod.apply(disabled.ctx, { enabled: false });
check('enabled=false で何も登録しない', disabled.tools.length === 0 && disabled.commands.length === 0);

// --- 5. 後始末（ctx.effect の teardown）が両方を解除する ---------------------------
const teardownHost = makeHost();
mod.apply(teardownHost.ctx, { promotedCategories: ['search', 'media'], commands: true });
teardownHost.teardown(); // ctx.effect に登録された後始末（DSH 終了時に走るもの）を呼ぶ
check('teardown でツールとコマンドの両方を解除', teardownHost.disposed.tools >= 1 && teardownHost.disposed.commands >= 1, JSON.stringify(teardownHost.disposed));

// --- 6. 任意: 実 CLI で genspark_status を 1 回実行 -------------------------------
if (withCli) {
  const status = host.tools.find((tool) => tool.name === 'genspark_status');
  try {
    const text = await status.execute({}, { agent: { session: { header: { cwd: root } } } });
    const lines = String(text).split('\n');
    console.log('\n  genspark_status の出力:');
    for (const line of lines) console.log(`    ${line}`);
    check('実 CLI の status に「コマンド:」行が出る', lines.some((line) => line.startsWith('コマンド: 13 件を登録しました')));
  } catch (error) {
    check('実 CLI の status 実行', false, String(error?.message));
  }
}

rmSync(temp, { recursive: true, force: true });
console.log(`\n結果: 成功 ${ok} / 失敗 ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
