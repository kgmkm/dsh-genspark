/**
 * 純ロジックの単体テスト（ホスト不要・ネットワーク不要）。
 * 実行: node --test tests/
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import test from 'node:test';

import { createCatalogCache, describeCatalogFull, filterTools, groupOf, groupSummary, summarizeCatalog } from '../lib/catalog.js';
import { resolveTmpRoot, writeArgsFile } from '../lib/gsk-cli.js';
import { describeRun, isEnvelope, parseEnvelope, truncate } from '../lib/result.js';
import { buildGensparkTools, resolveWritePolicy, schemaRequiresConfirmation } from '../lib/tools.js';

// ── result.js ────────────────────────────────────────────────────────────────

test('parseEnvelope: エンベロープ 1 行を取り出す', () => {
  const { value } = parseEnvelope('{"status":"ok","message":"done","data":{"a":1}}\n');
  assert.equal(value.status, 'ok');
  assert.equal(value.data.a, 1);
  assert.equal(isEnvelope(value), true);
});

test('parseEnvelope: 進捗行が混ざっても JSON 行を拾う', () => {
  const stdout = '[INFO] something\n{"status":"ok","message":"","data":[1,2]}\n';
  const { value } = parseEnvelope(stdout);
  assert.deepEqual(value.data, [1, 2]);
});

test('parseEnvelope: カタログ形式（エンベロープ無し）も読める', () => {
  const { value } = parseEnvelope('{"tools":[{"name":"web_search"}],"features":{}}');
  assert.equal(isEnvelope(value), false);
  assert.equal(value.tools.length, 1);
});

test('parseEnvelope: JSON が無ければ undefined', () => {
  const { value, raw } = parseEnvelope('not json at all');
  assert.equal(value, undefined);
  assert.match(raw, /not json/);
});

test('describeRun: ok エンベロープは data を整形して返す', () => {
  const result = { code: 0, stdout: '{"status":"ok","message":"","data":{"answer":42}}', stderr: '' };
  const described = describeRun(result, { tool: 'x' });
  assert.equal(described.ok, true);
  assert.match(described.text, /"answer": 42/);
});

test('describeRun: 終了コードが異常でもエンベロープが ok なら成功扱い（自動更新の汚染対策）', () => {
  const result = { code: 3221226505, stdout: '{"status":"ok","message":"","data":"1.14.0"}', stderr: 'Assertion failed: ...' };
  assert.equal(describeRun(result, { tool: '--version' }).ok, true);
});

test('describeRun: error エンベロープは error_code と指示を含める', () => {
  const result = {
    code: 1,
    stdout: JSON.stringify({ status: 'error', message: 'boom', error_code: 'E_X', retry_after: 30, instruction_for_agent: 'retry later' }),
    stderr: '',
  };
  const described = describeRun(result, { tool: 'x' });
  assert.equal(described.ok, false);
  assert.match(described.text, /boom/);
  assert.match(described.text, /E_X/);
  assert.match(described.text, /retry_after: 30/);
  assert.match(described.text, /retry later/);
});

test('describeRun: 認証エラーはログイン手順を案内する', () => {
  const result = { code: 1, stdout: '', stderr: '[ERROR] API key is required. Provide it via:' };
  const described = describeRun(result, { tool: 'web_search' });
  assert.equal(described.ok, false);
  assert.match(described.text, /gsk login/);
});

test('describeRun: exit code 2 は確認未承認として案内する', () => {
  const result = { code: 2, stdout: '', stderr: '' };
  const described = describeRun(result, { tool: 'slack' });
  assert.match(described.text, /承認/);
  assert.match(described.text, /approve_write/);
});

test('describeRun: タイムアウトは run_id 経由を案内する', () => {
  const described = describeRun({ code: null, stdout: '', stderr: '', timedOut: true }, { tool: 'create_task' });
  assert.equal(described.ok, false);
  assert.match(described.text, /task_status/);
});

test('truncate: 上限を超えたら切り詰める', () => {
  const { text, truncated, originalLength } = truncate('a'.repeat(50), 10);
  assert.equal(truncated, true);
  assert.equal(originalLength, 50);
  assert.match(text, /残り 40 文字/);
});

// ── catalog.js ───────────────────────────────────────────────────────────────

const FIXTURE = {
  tools: [
    {
      name: 'web_search',
      description: 'Search the web.',
      parameters: { type: 'object', properties: { q: { type: 'string', description: 'query' } }, required: ['q'] },
      cli: { aliases: ['search'], group: null, path: null, output_file_keys: [] },
    },
    {
      name: 'slack',
      description: 'Slack operations.',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['send', 'search'] }, message: { type: 'string' } }, required: ['action'] },
      actions: {
        send: { description: 'Send a message', parameters: ['message'], required: ['message'], requires_confirmation: true, interactive_only: true },
        search: { description: 'Search messages', parameters: ['query'], required: ['query'] },
      },
      cli: { aliases: [], group: null, path: null, interactive_only: false },
    },
    {
      name: 'gmail',
      description: 'Gmail operations.',
      parameters: { type: 'object', properties: {} },
      cli: { aliases: [], group: 'email', path: null },
    },
  ],
  features: { interactive_confirm: true },
};

test('groupOf: cli.path を最優先し、次に group、無ければ ungrouped', () => {
  assert.equal(groupOf({ cli: { path: ['task', 'create'], group: 'x' } }), 'task create');
  assert.equal(groupOf({ cli: { group: 'email' } }), 'email');
  assert.equal(groupOf({ cli: {} }), '(ungrouped)');
});

test('filterTools: keyword は名前・エイリアス・説明・グループ・action 名を対象に AND 検索する', () => {
  // "search" は web_search（名前）と slack（action: search）の両方に当たる
  assert.deepEqual(
    filterTools(FIXTURE.tools, { keyword: 'search' }).map((t) => t.name).sort(),
    ['slack', 'web_search'],
  );
  assert.equal(filterTools(FIXTURE.tools, { keyword: 'slack send' })[0].name, 'slack');
  assert.equal(filterTools(FIXTURE.tools, { group: 'email' })[0].name, 'gmail');
});

test('summarizeCatalog: 引数なしではグループ別件数と主要ツールを返す', () => {
  const text = summarizeCatalog(FIXTURE, {});
  assert.match(text, /全 3 ツール/);
  assert.match(text, /web_search/);
});

test('describeCatalogFull: 引数スキーマと action 一覧を返す', () => {
  const text = describeCatalogFull(FIXTURE, { keyword: 'slack' });
  assert.match(text, /action \(必須\)/);
  assert.match(text, /send \(要承認\/対話必須\)/);
  assert.match(text, /enum=\[send, search\]/);
});

test('groupSummary: 件数の降順', () => {
  const summary = groupSummary(FIXTURE.tools);
  assert.deepEqual(summary.map(([name]) => name), ['(ungrouped)', 'email']);
});

// ── tools.js（ホスト非依存の組み立て）───────────────────────────────────────

test('resolveWritePolicy: 既定は未承認＝--no-input、承認時のみ --yes', () => {
  assert.deepEqual(resolveWritePolicy({}, false).flags, ['--no-input']);
  assert.deepEqual(resolveWritePolicy({}, true).flags, ['--yes']);
  assert.deepEqual(resolveWritePolicy({ writeMode: 'deny' }, true).flags, ['--no-input']);
  assert.deepEqual(resolveWritePolicy({ writeMode: 'allow' }, false).flags, []);
});

test('schemaRequiresConfirmation: action 単位の確認要否を判定する', () => {
  const slack = FIXTURE.tools[1];
  assert.equal(schemaRequiresConfirmation(slack, { action: 'send' }), true);
  assert.equal(schemaRequiresConfirmation(slack, { action: 'search' }), false);
  assert.equal(schemaRequiresConfirmation({ cli: { requires_confirmation: true } }, {}), true);
});

test('buildGensparkTools: 3 つのツール定義を返し、parameters が DSL 仕様に沿う', () => {
  const defineTool = (spec) => spec;
  const tools = buildGensparkTools({ defineTool, getConfig: () => ({}), runner: {}, catalog: {} });
  assert.deepEqual(tools.map((t) => t.name), ['genspark_run', 'genspark_tools', 'genspark_status']);
  const run = tools[0];
  assert.equal(run.parameters.tool.required, true);
  assert.equal(run.parameters.args.type, 'json'); // 任意 JSON を受理する annotation-only schema
  assert.equal(run.parameters.approve_write.type, 'boolean');
  assert.equal(typeof run.execute, 'function');
});

test('createCatalogCache: ls の出力を解析してキャッシュする', async () => {
  const calls = [];
  const runner = {
    async run(argv) {
      calls.push(argv);
      return { code: 0, stdout: JSON.stringify(FIXTURE), stderr: '' };
    },
  };
  const cache = createCatalogCache({ getConfig: () => ({}) });
  const first = await cache.load(runner, {});
  assert.equal(first.tools.length, 3);
  assert.equal(first.cached, false);
  const second = await cache.load(runner, {});
  assert.equal(second.cached, true);
  assert.equal(calls.length, 1); // 2 回目はキャッシュ
  await cache.load(runner, { refresh: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['--output', 'json', '--refresh', 'ls']);
});

test('createCatalogCache: 解析できない出力は GSK_CATALOG_UNAVAILABLE で失敗する', async () => {
  const runner = { async run() {
    return { code: 1, stdout: '', stderr: '[ERROR] API key is required.' };
  } };
  const cache = createCatalogCache({ getConfig: () => ({}) });
  await assert.rejects(() => cache.load(runner, {}), /カタログを取得できませんでした/);
});

// ── 一時ディレクトリ（DSH 実機で --args-file が ENOENT になった不具合の回帰テスト） ──

test('resolveTmpRoot: 空文字・未設定・空白は OS の一時領域（絶対パス）へ倒す', () => {
  assert.equal(resolveTmpRoot(''), tmpdir());
  assert.equal(resolveTmpRoot(undefined), tmpdir());
  assert.equal(resolveTmpRoot(null), tmpdir());
  assert.equal(resolveTmpRoot('   '), tmpdir());
  assert.equal(resolveTmpRoot(123), tmpdir());
  assert.equal(isAbsolute(tmpdir()), true);
});

test('resolveTmpRoot: 相対指定は絶対パスへ正規化する（子プロセスの cwd に依存させない）', () => {
  const out = resolveTmpRoot('tmp/genspark');
  assert.equal(isAbsolute(out), true);
  assert.equal(out, resolve('tmp/genspark'));
  assert.equal(resolveTmpRoot('C:\\Temp\\genspark'), 'C:\\Temp\\genspark');
});

test('writeArgsFile: 相対ディレクトリを渡しても絶対パスを返し、内容は JSON として読める', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-genspark-args-unit-'));
  try {
    const rel = relative(process.cwd(), dir);
    const path = await writeArgsFile(rel, { q: 'テスト', n: 2 });
    assert.equal(isAbsolute(path), true);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { q: 'テスト', n: 2 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('describeRun: --args-file の ENOENT を「引数名の誤り」と誤診しない', () => {
  const result = {
    code: 1,
    ok: false,
    stdout: '',
    stderr: "[ERROR] --args-file: cannot read dsh-genspark-args-x\\args.json: ENOENT: no such file or directory, open 'C:\\w\\dsh-genspark-args-x\\args.json'",
  };
  const described = describeRun(result, { tool: 'web_search' });
  assert.equal(described.ok, false);
  assert.match(described.text, /引数ファイルを Genspark CLI が読み取れませんでした/);
  assert.doesNotMatch(described.text, /引数の名前が Genspark 側のスキーマと一致しません/);
});

test('describeRun: is not a param は従来どおり引数名の誤りとして案内する', () => {
  const described = describeRun(
    { code: 1, ok: false, stdout: '', stderr: '[ERROR] --args-file: "freshness" is not a param' },
    { tool: 'web_search' },
  );
  assert.match(described.text, /引数の名前が Genspark 側のスキーマと一致しません/);
  assert.match(described.text, /サーバーは呼び出されていません/);
});
