// 「全部の機能でエラーを試す」ためのプリフライト。
//
// 背景:
//   実機で `/genspark-crawl` に URL でない文字列を渡したところ、エラー表示に続いて
//   セッション形式 V4 の検証でターンごと失敗した（「このターンの実行に失敗しました
//   format v4 message requires a producer-owned source kind」）。利用者からは
//   「エラーハンドリングの処理が全く出来てません」「エラーテストは全部の機能で試しました？」
//   との指摘を受けた。
//
// このプリフライトは 13 コマンドすべてについて、起こりうる失敗の型を機械的に通し、
//   1. handler が例外を投げない（必ず { kind: 'error', text } を返す）
//   2. 文言が日本語で、生のスタックや英語の内部エラーを晒さない
//   3. 事前検証で弾けるものは CLI を起動しない（＝課金しない）
//   4. 引き継ぎメッセージが実物の V4 検証（assertV4RowAdmission）を通る
// を確認する。実物の検証器を使うのが要点で、偽の agent だけの単体テストでは
// 上記の実機不具合を見逃す。
//
// 使い方: node tests/preflight-error-sweep.mjs

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const hostModules = join(root, 'reference/asar/node_modules/@deepseek-ai');

const load = (relative) => import(new URL(`file://${join(hostModules, relative).replace(/\\/g, '/')}`).href);
const loadLocal = (relative) => import(new URL(`file://${join(here, '..', relative).replace(/\\/g, '/')}`).href);

const format = await load('dsh-session-format-v3-to-v4/lib/index.js');
const { buildGensparkCommands, withFollowup } = await loadLocal('lib/commands.js');

let ok = 0;
let fail = 0;
const failures = [];
const check = (label, passed, detail = '') => {
  if (passed) {
    ok += 1;
  } else {
    fail += 1;
    failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
};

const admit = (row) => {
  try {
    format.assertV4RowAdmission(row);
    return null;
  } catch (error) {
    return error?.message ?? String(error);
  }
};

const settle = () => new Promise((done) => setTimeout(done, 0));
const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/;
const RAW_STACK = /\n\s+at\s|node:internal|ERR_[A-Z_]+/;

const FAKE_TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web',
    cli: { group: 'search' },
    parameters: { properties: { q: { type: 'string' } }, required: ['q'] },
  },
];

/** 失敗の型ごとに偽ランナーを作る。calls に CLI 呼び出しを記録する。 */
function makeHarness(kind, calls, log) {
  const runner = {
    async runTool(toolName, toolArgs) {
      calls.push({ toolName, toolArgs });
      if (kind === 'throw') throw new Error('spawn EPERM（テスト用）');
      if (kind === 'envelope') {
        return {
          code: 0,
          stdout: JSON.stringify({ status: 'error', message: 'rate limited', error_code: 'RATE_LIMIT' }),
          stderr: '',
          ok: false,
        };
      }
      if (kind === 'garbage') return { code: 1, stdout: '', stderr: '[ERROR] not logged in', ok: false };
      if (kind === 'timeout') return { code: null, stdout: '', stderr: '', ok: false, timedOut: true };
      return { code: 0, stdout: JSON.stringify({ status: 'ok', message: 'success', data: {} }), stderr: '', ok: true };
    },
    resolveEntry: () => 'C:\\fake\\@genspark\\cli\\dist\\index.js',
    resolveRuntime: () => ({ path: 'C:\\node.exe', source: 'auto' }),
  };
  const commands = buildGensparkCommands({
    getConfig: () => ({
      timeoutMs: 600000,
      maxOutputChars: 100000,
      promotedCategories: ['search', 'media'],
      writeMode: 'approve',
      commandFollowup: true,
    }),
    runner,
    catalog: { async load() { return { tools: FAKE_TOOLS }; } },
    log,
  });
  return commands;
}

const seen = [];
const agent = {
  session: { header: { cwd: process.cwd() } },
  followup(message) {
    seen.push(message);
  },
};
const invocation = (rawInput) => ({ rawInput, commandId: 'c1', attachments: [], signal: undefined, agent });

/** 1 回実行して、結果と引き継ぎメッセージを返す。 */
async function run(commands, name, input, calls, log) {
  const command = commands.find((item) => item.name === name);
  const before = seen.length;
  const beforeCalls = calls.length;
  const result = await command.handler(invocation(input));
  await settle();
  return {
    result,
    message: seen[before],
    cliCalls: calls.length - beforeCalls,
    logLines: log.lines.length,
  };
}

const makeLog = () => {
  const lines = [];
  const log = (line) => lines.push(String(line));
  log.lines = lines;
  return log;
};

/** エラー結果として満たすべき条件をまとめて検査する。 */
function checkError(label, run1, { expectCli = false } = {}) {
  const { result, message, cliCalls } = run1;
  const text = typeof result?.text === 'string' ? result.text : '';
  check(`${label}: {kind:'error'}` , result?.kind === 'error', `kind=${result?.kind}`);
  check(`${label}: 文言が日本語`, JAPANESE.test(text), text.slice(0, 90));
  check(`${label}: 生のスタックを晒さない`, !RAW_STACK.test(text), text.slice(0, 90));
  check(`${label}: 文言が空でない`, text.trim().length > 0);
  const reason = message === undefined ? '引き継ぎが送られていない' : admit({ type: 'user/message', data: message });
  check(`${label}: 引き継ぎが V4 検証を通る`, reason === null, reason ?? '');
  if (!expectCli) {
    check(`${label}: CLI を起動しない（課金しない）`, cliCalls === 0, `${cliCalls} 回`);
  }
  return { text };
}

// ── 1. 13 コマンド × 3 種類の失敗（入力なし / ランナー例外 / エラー応答） ─────────────
console.log('1. 13 コマンドのエラー経路');
const names = makeHarness('ok', [], makeLog()).map((command) => command.name);
check('コマンドは 13 件', names.length === 13, names.join(' '));

for (const name of names) {
  // (a) 入力なし（引数が要るコマンドはここで弾かれる）
  {
    const calls = [];
    const log = makeLog();
    const commands = makeHarness('ok', calls, log);
    const out = await run(commands, name, '', calls, log);
    if (name === 'genspark') {
      // /genspark は引数不要（接続状態の表示）なので、ここはエラーにならない
      check(`${name}: 引数なしでも実行できる`, out.result?.kind === 'success', `kind=${out.result?.kind}`);
    } else if (name === 'genspark-tools') {
      // /genspark-tools も引数なしで「全ツール一覧」を返すのが正しい動作
      check(`${name}: 引数なしで全ツールを一覧する`, out.result?.kind === 'success', `kind=${out.result?.kind}`);
    } else {
      checkError(`${name}（入力なし）`, out);
    }
  }

  // (b) ランナーが例外を投げる
  {
    const calls = [];
    const log = makeLog();
    const commands = makeHarness('throw', calls, log);
    const input = name === 'genspark-tools' ? '' : name === 'genspark-run' ? 'me' : 'テスト';
    const out = await run(commands, name, input, calls, log);
    if (name === 'genspark' || name === 'genspark-tools') {
      // /genspark は各項目を個別に握り潰し、/genspark-tools はカタログだけを使う（ランナー不要）
      check(`${name}: ランナー例外でも結果を返す`, typeof out.result?.kind === 'string', `kind=${out.result?.kind}`);
    } else {
      checkError(`${name}（ランナー例外）`, out, { expectCli: true });
    }
  }

  // (c) ランナーがエラー応答を返す
  {
    const calls = [];
    const log = makeLog();
    const commands = makeHarness('envelope', calls, log);
    const input = name === 'genspark-tools' ? '' : name === 'genspark-run' ? 'me' : 'テスト';
    const out = await run(commands, name, input, calls, log);
    if (name === 'genspark' || name === 'genspark-tools') {
      check(`${name}: エラー応答でも結果を返す`, typeof out.result?.kind === 'string', `kind=${out.result?.kind}`);
    } else {
      checkError(`${name}（エラー応答）`, out, { expectCli: true });
    }
  }
}

// ── 2. 事前検証で弾けるものは CLI を起動しない ────────────────────────────────────
console.log('2. 事前検証（CLI を起動しないこと）');
for (const [name, input, why] of [
  ['genspark-crawl', 'これはテストです。昨日日本であった情報流出事件を教えてください', 'URL でもファイルでもない'],
  ['genspark-summarize', 'これはURLではない質問文です', 'URL でもファイルでもない'],
  ['genspark-run', 'web_search {"q":', '壊れた JSON'],
  ['genspark-run', '存在しないツール名', '存在しないツール'],
  ['genspark-search', '   ', '空白のみ'],
]) {
  const calls = [];
  const log = makeLog();
  const commands = makeHarness('ok', calls, log);
  const out = await run(commands, name, input, calls, log);
  checkError(`${name}（${why}）`, out);
}

// ── 3. ランナーが「時間切れ」「解釈できない出力」を返す場合 ────────────────────────
console.log('3. 時間切れ・解釈できない出力');
for (const kind of ['timeout', 'garbage']) {
  for (const name of ['genspark-search', 'genspark-analyze-media', 'genspark-run']) {
    const calls = [];
    const log = makeLog();
    const commands = makeHarness(kind, calls, log);
    const input = name === 'genspark-run' ? 'me' : 'テスト';
    const out = await run(commands, name, input, calls, log);
    checkError(`${name}（${kind}）`, out, { expectCli: true });
  }
}

// ── 4. プラグイン側の想定外（getConfig が壊れている / handler が不正な値を返す） ────
console.log('4. 想定外の内部エラー');
{
  const log = makeLog();
  const commands = buildGensparkCommands({
    getConfig: () => {
      throw new Error('設定の読み込みに失敗（テスト用）');
    },
    runner: { async runTool() { throw new Error('呼ばれないはず'); }, resolveEntry: () => null, resolveRuntime: () => ({ path: '', source: '' }) },
    catalog: { async load() { return { tools: [] }; } },
    log,
  });
  for (const name of ['genspark', 'genspark-search', 'genspark-run']) {
    const before = seen.length;
    const result = await commands.find((item) => item.name === name).handler(invocation('テスト'));
    await settle();
    check(`${name}: getConfig が壊れていても例外を投げない`, result?.kind === 'error' || result?.kind === 'success', `kind=${result?.kind}`);
    const message = seen[before];
    const reason = message === undefined ? null : admit({ type: 'user/message', data: message });
    check(`${name}: そのときの引き継ぎも V4 検証を通る`, reason === null, reason ?? '');
  }
  check('想定外の内部エラーはログに残る', log.lines.some((line) => /設定の読み込みに失敗|例外が発生しました|不正な結果/.test(line)), log.lines.slice(0, 2).join(' / '));
}
{
  const log = makeLog();
  const deps = { getConfig: () => ({ commandFollowup: true }), runner: {}, catalog: {}, log };
  // withFollowup の防御（例外 → 日本語エラー、不正な戻り値 → 日本語エラー）を直接確認する
  for (const [label, inner] of [
    ['同期 throw', () => { throw new Error('内部エラー（テスト用）'); }],
    ['非同期 reject', async () => { throw new Error('非同期エラー（テスト用）'); }],
    ['undefined を返す', async () => undefined],
    ['kind の無いオブジェクト', async () => ({ text: 'x' })],
    ['文字列を返す', async () => 'だめな戻り値'],
  ]) {
    const guarded = withFollowup({ name: 'genspark-search', gsk: 'web_search', handler: inner }, deps);
    const before = seen.length;
    const result = await guarded(invocation('テスト'));
    await settle();
    const text = typeof result?.text === 'string' ? result.text : '';
    check(`想定外（${label}）: 例外を投げず日本語エラーを返す`, result?.kind === 'error' && JAPANESE.test(text) && !RAW_STACK.test(text), `${result?.kind} / ${text.slice(0, 70)}`);
    const message = seen[before];
    const reason = message === undefined ? '引き継ぎが送られていない' : admit({ type: 'user/message', data: message });
    check(`想定外（${label}）: 引き継ぎも V4 検証を通る`, reason === null, reason ?? '');
  }
  check('想定外の内部エラーはログに残る', log.lines.some((line) => /例外が発生しました|不正な結果/.test(line)), log.lines.slice(0, 2).join(' / '));
}

console.log(`\n結果: 成功 ${ok} / 失敗 ${fail}`);
if (fail > 0) {
  console.log('\n失敗した検査:');
  for (const line of failures) console.log(`  ✘ ${line}`);
}
process.exitCode = fail === 0 ? 0 : 1;
