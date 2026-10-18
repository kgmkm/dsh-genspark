// ホスト実物の dsh-commands（app.asar から抽出）に、こちらの 14 コマンド定義を
// 実際に登録して検証するプリフライト。
//
// 目的: コマンド名・description・input.hint の契約違反や既存コマンドとの名前衝突は
//       **register 時に throw** する。1 件でも throw するとそのコマンドがメニューに
//       出ないため、再起動の前にホスト実物の validator を通しておく。
//       さらに「サービスが無いプロファイルでも壊れない」こと（任意依存）と
//       「fiber を dispose するとコマンドが消える」ことも確認する。
//
// 使い方: node tests/preflight-commands-host.mjs
// 前提  : reference/asar/node_modules/@deepseek-ai/{cordis,dsh-commands}（抽出済み）
//         @deepseek-ai/dsh-llm は callConfigEquals を含む最小スタブ（reference/asar 内）

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

// 登録時に CLI を起動してしまわないことを検証するためのスタブ
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

console.log(`ホスト実物 dsh-commands に登録するコマンド: ${definitions.length} 件\n`);

// --- 1. ホストサービスを実際にマウントする --------------------------------------
const app = new cordis.Context();
const serviceFiber = app.plugin(commandsModule.default ?? commandsModule.CommandRuntime);
await settle();
const service = app.commands;
check('commands サービスがマウントされた', typeof service?.register === 'function', service?.constructor?.name);

// --- 2. メニューに既に出ている他プラグインのコマンドを先に置く（衝突検出の前提） ----
const HOST_NAMES = ['compact', 'permission', 'model', 'export', 'acp', 'acp-cache', 'feedback', 'goal', 'plan', 'file'];
for (const name of HOST_NAMES) {
  service.register({ name, description: `host ${name}`, handler: async () => ({ kind: 'success' }) });
}
check('既存コマンドを 10 件登録できた', service.list(undefined).length === HOST_NAMES.length);

// --- 3. 14 コマンドをホスト validator に通す --------------------------------------
for (const definition of definitions) {
  try {
    const disposer = service.register(definition);
    check(`${definition.name} を登録`, typeof disposer === 'function');
  } catch (error) {
    check(`${definition.name} を登録`, false, error?.message ?? String(error));
  }
}

const listed = service.list(undefined).map((descriptor) => descriptor.name);
const expected = definitions.map((definition) => definition.name).sort();
const mine = listed.filter((name) => !HOST_NAMES.includes(name));
check(
  '登録後の一覧が 14 件と一致',
  JSON.stringify(mine) === JSON.stringify(expected),
  mine.join(', '),
);

// --- 4. ホスト自身のパーサ・照会で見えるか ---------------------------------------
for (const definition of definitions) {
  const parsed = commandsModule.parseCommand(`/${definition.name} テスト入力`);
  check(`/${definition.name} がホストのパーサで解釈される`, parsed?.name === definition.name, JSON.stringify(parsed));

  const found = service.find(undefined, definition.name);
  check(
    `find() で description と hint が取れる`,
    found?.description === definition.description && found?.input?.hint === definition.input?.hint,
    found?.input?.hint ?? '(hint なし)',
  );
}

// --- 5. 重複登録はホストが拒否する（こちらの一意性が保証されている前提の確認） ------
try {
  service.register(definitions[0]);
  check('同名の二重登録をホストが拒否', false, '拒否されなかった');
} catch (error) {
  check('同名の二重登録をホストが拒否', /already registered/.test(String(error?.message)), String(error?.message).slice(0, 60));
}

// --- 6. 不正な定義はホストの validator が弾く（この検証が効いている証拠） -----------
const invalid = [
  ['大文字を含む名前', { name: 'Genspark-Bad', description: 'x', handler: async () => ({ kind: 'success' }) }],
  ['空の hint', { name: 'genspark-bad', description: 'x', input: { hint: '   ' }, handler: async () => ({ kind: 'success' }) }],
  ['handler が関数でない', { name: 'genspark-bad2', description: 'x', handler: 'nope' }],
];
for (const [label, definition] of invalid) {
  try {
    service.register(definition);
    check(`不正な定義を拒否: ${label}`, false, '拒否されなかった');
  } catch (error) {
    check(`不正な定義を拒否: ${label}`, true, String(error?.message).slice(0, 70));
  }
}

// --- 7. 登録は CLI を起動しない（副作用なし） -------------------------------------
check('登録だけで CLI を呼んでいない', calls.length === 0, `runner 呼び出し ${calls.length} 件`);

// --- 8. index.js と同じ任意依存 + dispose の経路 -----------------------------------
const app2 = new cordis.Context();
const serviceFiber2 = app2.plugin(commandsModule.default ?? commandsModule.CommandRuntime);
await settle();

let fired = 0;
const commandFiber = app2.inject(['commands'], (inner) => {
  fired += 1;
  for (const definition of definitions) inner.commands.register(definition);
});
await settle();
check('ctx.inject(["commands"]) のコールバックが走った', fired === 1, `fired=${fired}`);
const insideCount = app2.commands.list(undefined).length;
check('inject 経由でも 14 件が登録される', insideCount === definitions.length, `${insideCount} 件`);

commandFiber.dispose();
await settle();
const afterDispose = app2.commands.list(undefined).length;
check('fiber.dispose() でコマンドが消える', afterDispose === 0, `${afterDispose} 件`);

// --- 9. commands サービスが無いプロファイルでは何も起きない（任意依存） -------------
const app3 = new cordis.Context();
let fired3 = 0;
const fiber3 = app3.inject(['commands'], () => {
  fired3 += 1;
});
await settle();
check('サービスが無ければコールバックは走らない', fired3 === 0, `fired=${fired3}`);
check('サービスが無くても Context は健全', app3.get('commands') === undefined);
fiber3.dispose();
serviceFiber.dispose();
serviceFiber2.dispose();

console.log(`\n結果: 成功 ${ok} / 失敗 ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
