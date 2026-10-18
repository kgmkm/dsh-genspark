// ホスト実物の dsh-commands の **execute()（ディスパッチャ）** に本物のコマンド行を流し、
// 受付 → command/run → handler → 整形 → command/done の全経路を検証するプリフライト。
//
// 目的: 登録できること（preflight-commands-host.mjs）と、実際に動くこと（このファイル）は別。
//       ここでは `/genspark-…` の行を実物の CommandRuntime.execute() に渡し、
//       戻り値・セッションログへの command/run・command/done・エラー時の挙動まで確認する。
//
// 使い方: node tests/preflight-commands-exec.mjs [--with-cli]
//         --with-cli を付けると実 CLI を使う検証も走る（読み取り系のみ・数クレジット）
// 前提  : reference/asar/node_modules/@deepseek-ai/{cordis,dsh-commands}（抽出済み）

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const hostModules = join(root, 'reference/asar/node_modules/@deepseek-ai');
const withCli = process.argv.includes('--with-cli');

const load = (relative) =>
  import(new URL(`file://${join(hostModules, relative).replace(/\\/g, '/')}`).href);
const loadLocal = (relative) =>
  import(new URL(`file://${join(here, '..', relative).replace(/\\/g, '/')}`).href);

const cordis = await load('cordis/lib/index.js');
const commandsModule = await load('dsh-commands/lib/index.js');
const { buildGensparkCommands } = await loadLocal('lib/commands.js');

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

const FAKE_TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web',
    cli: { aliases: ['ws'], group: 'search' },
    parameters: { properties: { q: { type: 'string', description: 'query' } }, required: ['q'] },
  },
];

/** 記録用のスタブ runner / catalog を載せた実行環境を作る。 */
async function makeRuntime({ runTool, tools = FAKE_TOOLS } = {}) {
  const calls = [];
  const envelope = (data) => ({ status: 'ok', message: 'success', data });
  const stubRunner = {
    async runTool(toolName, toolArgs, options) {
      calls.push({ kind: 'runTool', toolName, toolArgs, options });
      if (runTool) return await runTool({ toolName, toolArgs, options });
      return { code: 0, ok: true, stdout: JSON.stringify(envelope({ echo: toolArgs })), stderr: '' };
    },
    async run(argv) {
      calls.push({ kind: 'run', argv });
      return { code: 0, ok: true, stdout: JSON.stringify(envelope({ email: 'test@example.com', plan: 'plus' })), stderr: '' };
    },
    resolveEntry: () => 'C:\\fake\\@genspark\\cli\\dist\\index.js',
    resolveRuntime: () => ({ path: 'C:\\Program Files\\nodejs\\node.exe', source: 'auto' }),
  };
  const stubCatalog = {
    async load(_runner, options) {
      calls.push({ kind: 'catalog', options });
      return { tools, features: {} };
    },
    peek: () => undefined,
  };

  const config = { promotedCategories: ['search', 'media'], timeoutMs: 300000, maxChars: 4000, debug: false };
  const definitions = buildGensparkCommands({ getConfig: () => config, runner: stubRunner, catalog: stubCatalog, log });

  const app = new cordis.Context();
  const fiber = app.plugin(commandsModule.default ?? commandsModule.CommandRuntime);
  await settle();
  for (const definition of definitions) app.commands.register(definition);

  const appends = [];
  const agent = { session: { append(type, data) { appends.push({ type, data }); } } };
  const ranTools = () => calls.filter((call) => call.kind === 'runTool');
  return { app, fiber, service: app.commands, definitions, calls, ranTools, appends, agent };
}

const line = (name, rest = '') => `/${name}${rest === '' ? '' : ` ${rest}`}`;
const signal = () => new AbortController().signal;

console.log('ホスト実物 CommandRuntime.execute() に流す検証\n');

const env = await makeRuntime({});
const { service, appends, calls, ranTools, agent } = env;
check('commands サービスがマウントされた', typeof service?.execute === 'function');

// --- 1. 受付の段階で落ちる行は何も記録しない --------------------------------------
const noSlash = await service.execute(agent, 'genspark-search 東京', [], signal());
check('スラッシュ無しは解決されない（undefined）', noSlash === undefined);
const unknown = await service.execute(agent, '/nope テスト', [], signal());
check('未知のコマンド名は解決されない（undefined）', unknown === undefined);
check('受付ミスは command/run を記録しない', appends.length === 0, `${appends.length} 件`);

// --- 2. 壊れた JSON はハンドラ内で拒否され、CLI を起動しない ------------------------
const broken = await service.execute(agent, line('genspark-run', 'web_search {oops}'), [], signal());
check('壊れた JSON は error 結果', broken?.result?.kind === 'error', broken?.result?.text?.slice(0, 60));
check('壊れた JSON では CLI もカタログも触らない', calls.length === 0, `runner 呼び出し ${calls.length} 件`);

// --- 3. ライフサイクル（command/run → command/done）が正しく対になる ----------------
const [runEvent, doneEvent] = appends;
check('command/run が記録される', runEvent?.type === 'command/run');
check('command/run の name と args', runEvent?.data?.name === 'genspark-run' && runEvent?.data?.args === ' web_search {oops}', JSON.stringify(runEvent?.data?.args));
check('command/run の source は user', runEvent?.data?.source?.kind === 'user');
check('command/done が記録される', doneEvent?.type === 'command/done');
check('commandId が対になる', runEvent?.data?.commandId === doneEvent?.data?.commandId, String(doneEvent?.data?.commandId));
check('command/done の kind は error', doneEvent?.data?.kind === 'error');
check('command/done に本文が入る', typeof doneEvent?.data?.text === 'string' && doneEvent.data.text.length > 0, `${doneEvent?.data?.text?.length ?? 0} 文字`);

// --- 4. 正常系: 引数がスタブ runner まで届く ---------------------------------------
appends.length = 0;
const search = await service.execute(agent, line('genspark-search', '東京'), [], signal());
check('/genspark-search が success', search?.result?.kind === 'success', search?.result?.text?.slice(0, 50));
check('web_search が呼ばれた', ranTools().length === 1 && ranTools()[0].toolName === 'web_search', ranTools()[0]?.toolName);
check('クエリが引数として届く', String(ranTools()[0]?.toolArgs?.q ?? '').includes('東京'), JSON.stringify(ranTools()[0]?.toolArgs));
check('done が success で記録される', appends.at(-1)?.data?.kind === 'success');

// --- 5. 引数不足はハンドラが日本語で拒否する ---------------------------------------
calls.length = 0;
const noArg = await service.execute(agent, line('genspark-search'), [], signal());
check('引数不足は error 結果', noArg?.result?.kind === 'error', noArg?.result?.text?.slice(0, 50));
check('引数不足では CLI を起動しない', calls.length === 0, `runner 呼び出し ${calls.length} 件`);

// --- 5.5 実ディスパッチャ経由で結果が agent.followup へ引き継がれる ------------------
// コマンド結果は既定では画面のコマンド欄にしか出ないため、実行後に結果をモデルへ渡す
// （lib/commands.js の scheduleFollowup）。ここでは「handler が受け取る agent が、
// アダプタが execute に渡したオブジェクトそのものか」を実物ディスパッチャで確かめる。
const followups = [];
const followupAgent = {
  session: {
    append(type, data) {
      appends.push({ type, data });
    },
  },
  followup(message) {
    followups.push(message);
  },
};
calls.length = 0;
const followSearch = await service.execute(followupAgent, line('genspark-search', '東京'), [], signal());
check('followup 対応 agent でも success', followSearch?.result?.kind === 'success', followSearch?.result?.text?.slice(0, 50));
// 引き継ぎはコマンド完了を待たせないよう次のティックへ遅らせている（command/done を妨げない）
await new Promise((resolve) => setTimeout(resolve, 0));
check('followup が 1 回だけ呼ばれる', followups.length === 1, `${followups.length} 件`);
check(
  'followup の source は V4 の正準 producer kind',
  followups[0]?.source?.kind === 'plugin:dsh-genspark',
  JSON.stringify(followups[0]?.source),
);
const followText = followups[0]?.content?.[0]?.text ?? '';
check('followup の本文に見出しと結果が入る', followText.includes('Genspark のコマンド実行結果です（/genspark-search 東京）') && followText.includes('状態: 成功'), followText.slice(0, 70));
check('followup は結果本文（コマンド欄と同じ内容）を含む', followText.length > followSearch.result.text.length, `${followText.length} 文字`);

// --- 6. 13 コマンドすべてがディスパッチャに解決される -------------------------------
const unresolved = [];
for (const definition of env.definitions) {
  const settled = await service.execute(agent, `/${definition.name}`, [], signal());
  if (settled === undefined) unresolved.push(definition.name);
}
check('13 コマンドすべてが execute で解決される', unresolved.length === 0, unresolved.join(', ') || '13/13');

// --- 7. 中断シグナルはハンドラを走らせない -----------------------------------------
calls.length = 0;
const controller = new AbortController();
controller.abort();
let aborted = false;
try {
  await service.execute(agent, line('genspark-search', '東京'), [], controller.signal);
} catch {
  aborted = true;
}
check('中断済みシグナルでは throw する', aborted);
check('中断時は CLI を起動しない', calls.length === 0, `runner 呼び出し ${calls.length} 件`);

// --- 8. handler が throw した場合のホスト側の扱い（この設計を選んだ理由の確認） ------
service.register({
  name: 'genspark-throw-probe',
  description: 'probe',
  handler: async () => {
    throw new Error('probe failure');
  },
});
appends.length = 0;
let thrown = false;
try {
  await service.execute(agent, '/genspark-throw-probe', [], signal());
} catch {
  thrown = true;
}
check('handler の throw は execute から伝播する', thrown);
check('throw でも command/done に error が残る', appends.at(-1)?.type === 'command/done' && appends.at(-1)?.data?.kind === 'error');

env.fiber.dispose();
await settle();

// --- 9. 実 CLI で通す（--with-cli） ------------------------------------------------
if (withCli) {
  console.log('\n実 CLI 経由（読み取り系のみ）\n');
  const { createRunner } = await loadLocal('lib/gsk-cli.js');
  const { createCatalogCache } = await loadLocal('lib/catalog.js');
  const config = { promotedCategories: ['search', 'media'], timeoutMs: 600000, maxChars: 100000, debug: false };
  const runner = createRunner({ getConfig: () => config, env: process.env });
  const catalog = createCatalogCache({ getConfig: () => config, log });
  const definitions = buildGensparkCommands({ getConfig: () => config, runner, catalog, log });
  const app = new cordis.Context();
  const fiber = app.plugin(commandsModule.default ?? commandsModule.CommandRuntime);
  await settle();
  for (const definition of definitions) app.commands.register(definition);
  const appends = [];
  const agent = { session: { append(type, data) { appends.push({ type, data }); } } };

  const cliSearch = await app.commands.execute(agent, '/genspark-search DeepSeek Harness plugin', [], signal());
  check(
    '/genspark-search が実 CLI で success',
    cliSearch?.result?.kind === 'success' && /organic_results/.test(cliSearch.result.text),
    cliSearch?.result?.text?.split('\n')[0]?.slice(0, 70),
  );
  const cliVisionAvailable = (() => {
    try { return agent.session?.header?.cwd ?? process.cwd(), true; } catch { return true; }
  })();
  // Vision はローカルファイルが必要だが、ここではコマンド登録の確認だけ（実画像は integration 側で）
  const cliVision = await app.commands.execute(agent, '/genspark-vision D:\\Documents\\deepseek-harness\\default-workspace\\genspark-out\\test_cat.jpg', [], signal());
  check(
    '/genspark-vision が実 CLI で success（画像）',
    cliVision?.result?.kind === 'success' && /猫|analysis|内容/i.test(cliVision.result.text),
    cliVision?.result?.text?.split('\n')[0]?.slice(0, 70),
  );
  void cliVisionAvailable;
  const cliStatus = await app.commands.execute(agent, '/genspark', [], signal());
  check(
    '/genspark が実 CLI で success',
    cliStatus?.result?.kind === 'success' && /コマンド:/.test(cliStatus.result.text),
    cliStatus?.result?.text?.split('\n')[0]?.slice(0, 70),
  );
  check('実 CLI 実行でも lifecycle が残る', appends.filter((e) => e.type === 'command/run').length === 3, `${appends.filter((e) => e.type === 'command/run').length} 件`);

  // 実 CLI の結果がそのままモデルへ渡ること（今回の要望の経路そのもの）
  const cliFollowups = [];
  const followupAgent = {
    session: { append(type, data) { appends.push({ type, data }); } },
    followup(message) { cliFollowups.push(message); },
  };
  const cliFollowSearch = await app.commands.execute(followupAgent, '/genspark-search DeepSeek Harness plugin', [], signal());
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cliFollowText = cliFollowups[0]?.content?.[0]?.text ?? '';
  check(
    '実 CLI の検索結果がモデルへ引き継がれる',
    cliFollowups.length === 1 && cliFollowText.includes('状態: 成功') && cliFollowText.includes(cliFollowSearch.result.text),
    `${cliFollowText.length} 文字 / ${cliFollowups.length} 件`,
  );
  check(
    '引き継ぎ本文が日本語の指示で終わる',
    cliFollowText.includes('同じ内容を繰り返さず'),
    cliFollowText.slice(-60).replace(/\n/g, ' '),
  );
  fiber.dispose();
  await settle();
}

console.log(`\n結果: 成功 ${ok} / 失敗 ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
