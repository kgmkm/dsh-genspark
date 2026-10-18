/**
 * ホストコマンド（lib/commands.js）の単体テスト。ホスト不要・ネットワーク不要。
 * 実行: node tests/commands.test.mjs
 *
 * `@deepseek-ai/dsh-commands` の契約（asar 内の実装で確認）:
 *   - name は /^[a-z][a-z0-9_-]*$/
 *   - description は非空文字列
 *   - input を付けるなら { hint: 非空文字列 }
 *   - handler は { kind: 'success' | 'error', text } を返す
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { autoSavePath, buildGensparkCommands, humanizeData } from '../lib/commands.js';

/** ホスト側の既存コマンド名（これらと衝突すると登録時に throw する）。 */
const HOST_COMMANDS = ['compact', 'permission', 'model', 'export', 'acp', 'acp-cache', 'feedback', 'goal', 'plan', 'file'];

const FAKE_TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web',
    cli: { aliases: ['ws'], group: 'search' },
    parameters: { properties: { q: { type: 'string', description: 'query' } }, required: ['q'] },
  },
  {
    name: 'x_post_tweet',
    description: 'Post a tweet',
    cli: { group: 'x', interactive_only: true },
    parameters: { properties: {} },
  },
  {
    name: 'slack_send',
    description: 'Send a Slack message',
    cli: { group: 'slack', requires_confirmation: true },
    parameters: { properties: {} },
  },
];

const OK_ENVELOPE = (data) => ({ status: 'ok', message: 'success', data });

/** テスト用のコマンド一式を組み立てる。 */
function harness({ categories, runResult, tools = FAKE_TOOLS, catalogError, calls = [], config = {}, onRun, log, ctx } = {}) {
  const commands = buildGensparkCommands({
    ctx,
    getConfig: () => ({
      timeoutMs: 600000,
      maxOutputChars: 100000,
      promotedCategories: categories ?? ['search', 'media'],
      writeMode: 'approve',
      ...config,
    }),
    runner: {
      async runTool(toolName, toolArgs, options) {
        calls.push({ toolName, toolArgs, options });
        if (onRun) return await onRun({ toolName, toolArgs, options });
        return (
          runResult ?? {
            code: 0,
            stdout: JSON.stringify(OK_ENVELOPE({ echo: toolArgs })),
            stderr: '',
            ok: true,
          }
        );
      },
      resolveEntry: () => 'C:\\fake\\@genspark\\cli\\dist\\index.js',
      resolveRuntime: () => ({ path: 'C:\\Program Files\\nodejs\\node.exe', source: 'auto' }),
    },
    catalog: {
      async load(_runner, options) {
        calls.push({ catalog: options });
        if (catalogError) throw catalogError;
        return { tools };
      },
    },
    log,
  });
  return { commands, byName: new Map(commands.map((command) => [command.name, command])), calls };
}

const inv = (rawInput, cwd = process.cwd(), agent = { session: { header: { cwd } } }) => ({
  rawInput,
  commandId: 'c1',
  attachments: [],
  signal: undefined,
  agent,
});

/** 添付付きの invocation（agent に attachments サービスを持たせる）。 */
const invAttached = (rawInput, blocks, store, cwd = process.cwd()) => ({
  rawInput,
  commandId: 'c2',
  attachments: blocks,
  signal: undefined,
  agent: {
    session: { header: { cwd } },
    ctx: { get: (name) => (name === 'attachments' ? store : undefined) },
  },
});

/** 画像 1 件の添付ブロック（ホストが渡す形）。 */
const imageBlock = (id = 'sha256:img1', name = 'test_cat.jpg') => ({
  type: 'image',
  attachment: { attachmentId: id, mediaType: 'image/jpeg', name },
});

/** ファイル 1 件の添付ブロック（ホストが渡す形）。 */
const fileBlock = (id = 'sha256:doc1', name = 'doc.pdf') => ({
  type: 'file',
  attachment: { attachmentId: id, mediaType: 'application/pdf', name },
});

/** followup を受け取る擬似エージェント（受け取った message を seen に積む）。 */
const followupAgent = (seen, cwd = process.cwd()) => ({
  session: { header: { cwd } },
  followup(message) {
    seen.push(message);
  },
});

/**
 * 引き継ぎはコマンド完了を待たせないよう次のティックへ遅らせているため、
 * 検証前に 1 ティック進める（実機で「コマンドが完了しない」状態を避けるための設計）。
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const okData = (text) => ({ code: 0, stdout: JSON.stringify(OK_ENVELOPE(text)), stderr: '', ok: true });

// ── 登録されるコマンド ───────────────────────────────────────────────────────

test('既定では汎用 4 + 検索・調査 6 + 生成メディア 4 の 14 コマンドを返す', () => {
  const { commands } = harness({});
  assert.equal(commands.length, 14);
  assert.deepEqual(
    commands.map((command) => command.name),
    [
      'genspark',
      'genspark-tools',
      'genspark-models',
      'genspark-run',
      'genspark-search',
      'genspark-image-search',
      'genspark-crawl',
      'genspark-scholar',
      'genspark-maps',
      'genspark-summarize',
      'genspark-image',
      'genspark-video',
      'genspark-audio',
      'genspark-analyze-media',
    ],
  );
});

test('カテゴリを絞ると該当コマンドだけになる（汎用 4 は常時）', () => {
  assert.equal(harness({ categories: ['search'] }).commands.length, 10);
  assert.equal(harness({ categories: ['media'] }).commands.length, 8);
  assert.equal(harness({ categories: [] }).commands.length, 4);
  const { byName } = harness({ categories: ['search'] });
  assert.equal(byName.has('genspark-image'), false);
  assert.equal(byName.has('genspark-search'), true);
});

test('未知のカテゴリは無視してログに出す', () => {
  const logs = [];
  const commands = buildGensparkCommands({
    getConfig: () => ({ promotedCategories: ['search', 'nope'] }),
    runner: { runTool: async () => okData({}) },
    catalog: { load: async () => ({ tools: [] }) },
    log: (message) => logs.push(message),
  });
  assert.equal(commands.length, 10);
  assert.match(logs.join('\n'), /未知のカテゴリ "nope"/);
});

test('コマンドのメタデータが dsh-commands の契約を満たす', () => {
  const { commands } = harness({});
  for (const command of commands) {
    assert.match(command.name, /^[a-z][a-z0-9_-]*$/, command.name);
    assert.equal(HOST_COMMANDS.includes(command.name), false, `${command.name} はホストの既存コマンドと衝突する`);
    assert.equal(typeof command.description, 'string');
    assert.ok(command.description.trim().length > 0, `${command.name} の description が空`);
    assert.equal(typeof command.handler, 'function');
    if (command.input !== undefined) {
      assert.equal(typeof command.input.hint, 'string');
      assert.ok(command.input.hint.trim().length > 0, `${command.name} の hint が空`);
    }
  }
  // 引数が要らないのは /genspark（状態表示）だけ
  const withInput = commands.filter((command) => command.input !== undefined).map((command) => command.name);
  assert.equal(withInput.includes('genspark'), false);
  assert.equal(withInput.length, 13);
});

test('添付を受け取るコマンドだけ input.attachments=true を宣言する', () => {
  const { byName } = harness({});
  const accepting = ['genspark-analyze-media', 'genspark-summarize', 'genspark-crawl', 'genspark-image', 'genspark-video'];
  for (const name of accepting) {
    assert.equal(byName.get(name).input?.attachments, true, `${name} が添付を受け取れない`);
  }
  for (const command of harness({}).commands) {
    if (accepting.includes(command.name)) continue;
    assert.notEqual(command.input?.attachments, true, `${command.name} は添付を受け取らないはず`);
  }
});

// ── 昇格ツール由来のコマンド ─────────────────────────────────────────────────

test('genspark-search は web_search を --args-file 経由で実行する', async () => {
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-search').handler(inv('DeepSeek Harness'));
  assert.equal(result.kind, 'success');
  assert.equal(calls[0].toolName, 'web_search');
  assert.deepEqual(calls[0].toolArgs, { q: 'DeepSeek Harness' });
  assert.deepEqual(calls[0].options.globalArgs, ['--output', 'json', '--timeout', '600000', '--no-input']);
  assert.equal(calls[0].options.cwd, process.cwd());
  assert.match(result.text, /（tool: web_search）/);
});

test('入力が空なら実行せずエラーを返す', async () => {
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-search').handler(inv('   '));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /入力が必要です。使い方: \/genspark-search/);
  assert.equal(calls.length, 0);
});

test('genspark-crawl は URL でない入力（日本語の質問）を実行前に日本語で案内する', async () => {
  // 実機で起きた事象の再現防止: /genspark-crawl に質問文を渡すと
  // 「Genspark API エラー: No content found or crawler failed for …」になっていた。
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-crawl').handler(inv('これはテストです。昨日日本であった情報流出事件を教えてください'));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /http\(s\) で始まる URL/);
  assert.match(result.text, /\/genspark-search/);
  assert.equal(calls.length, 0);
});

test('検索結果は一覧として整形される（JSON をそのまま出さない）', async () => {
  const { byName } = harness({
    runResult: okData({
      organic_results: [
        { title: 'DeepSeek Harness の紹介', url: 'https://example.com/a', snippet: 'プラグインの作り方' },
        { title: '2 件目', url: 'https://example.com/b' },
      ],
      related_searches: ['dsh plugin', 'cordis'],
    }),
  });
  const result = await byName.get('genspark-search').handler(inv('dsh'));
  assert.equal(result.kind, 'success');
  assert.match(result.text, /organic_results: 2 件（先頭 2 件を表示）/);
  assert.match(result.text, /1\. DeepSeek Harness の紹介\n   https:\/\/example\.com\/a\n   プラグインの作り方/);
  assert.match(result.text, /related_searches: dsh plugin \/ cordis/);
  assert.equal(result.text.includes('"title"'), false);
});

test('genspark-image は genspark-out へ保存し、保存結果を報告する', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-genspark-cmd-'));
  const { byName, calls } = harness({
    onRun: async ({ options }) => {
      // CLI の -o の代わりに成果物を作る
      const path = options.toolArgs[options.toolArgs.indexOf('-o') + 1];
      writeFileSync(path, '12345');
      return okData({ images: [{ url: 'https://example.com/i.png' }] });
    },
  });
  const result = await byName.get('genspark-image').handler(inv('a red cube', cwd));
  assert.equal(result.kind, 'success');
  // save_to は Genspark の引数ではなく CLI の -o オプションになる
  assert.deepEqual(calls[0].toolArgs, { query: 'a red cube' });
  const out = calls[0].options.toolArgs;
  assert.equal(out[0], '-o');
  const savedPath = out[1];
  assert.ok(savedPath.startsWith(join(cwd, 'genspark-out')), savedPath);
  assert.match(savedPath, /\.png$/);
  assert.match(result.text, /保存ファイル: .*（5 バイト）/);
});

test('genspark-video は既定モデルと 30 分のタイムアウト下限を使う', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-genspark-cmd-'));
  const { byName, calls } = harness({});
  await byName.get('genspark-video').handler(inv('a drone shot', cwd));
  assert.equal(calls[0].toolName, 'video_generation');
  assert.equal(calls[0].toolArgs.model, 'kling/v3');
  assert.equal(calls[0].options.timeoutMs, 1800000);
  assert.deepEqual(calls[0].options.globalArgs, ['--output', 'json', '--timeout', '1800000', '--no-input']);
});

// ── 誤爆ガード（生成コマンドにモデル一覧・使い方を書いても課金しない） ────────────

const withModelTools = () => harness({ tools: [...FAKE_TOOLS, ...MODEL_TOOLS] });
const ranTool = (calls) => calls.some((call) => typeof call.toolName === 'string');

test('生成コマンドはモデル一覧の依頼を生成せずにモデル一覧で返す', async () => {
  const { byName, calls } = withModelTools();
  const video = await byName.get('genspark-video').handler(inv('動画モデルのリストください'));
  assert.equal(ranTool(calls), false, 'モデル一覧の依頼で生成ツールが実行された');
  assert.equal(video.kind, 'success');
  assert.match(video.text, /生成は行っていません/);
  assert.match(video.text, /kling\/v3/);

  const audio = await byName.get('genspark-audio').handler(inv('使える音声モデルを教えて'));
  assert.equal(ranTool(calls), false);
  assert.match(audio.text, /elevenlabs\/v4-tts/);
});

test('生成コマンドは「使い方」でクレジットを消費しない', async () => {
  const { byName, calls } = withModelTools();
  const result = await byName.get('genspark-image').handler(inv('使い方'));
  assert.equal(ranTool(calls), false, '「使い方」で生成ツールが実行された');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /\/genspark-image の使い方/);
  assert.match(result.text, /クレジットは消費していません/);
});

test('「モデル」を含む通常の生成依頼はガードせず生成する', async () => {
  const { byName, calls } = withModelTools();
  await byName.get('genspark-video').handler(inv('モデルのような女性が歩く動画'));
  assert.equal(calls[0].toolName, 'video_generation');
  assert.equal(calls[0].toolArgs.query, 'モデルのような女性が歩く動画');
});

test('添付があるときはモデル一覧の文言でも生成する（生成対象が明確なため）', async () => {
  const { byName, calls } = withModelTools();
  const store = { imageHostPath: () => 'C:\\tmp\\ref.png' };
  await byName.get('genspark-video').handler(invAttached('モデルのリスト', [imageBlock('sha256:i3', 'ref.png')], store));
  assert.equal(calls[0].toolName, 'video_generation');
  assert.deepEqual(calls[0].toolArgs.image_urls, ['C:\\tmp\\ref.png']);
});

test('genspark-summarize は URL だけでも既定の質問で実行できる', async () => {
  const { byName, calls } = harness({});
  await byName.get('genspark-summarize').handler(inv('https://example.com/doc.pdf'));
  assert.deepEqual(calls[0].toolArgs, {
    url: 'https://example.com/doc.pdf',
    question: 'この文書の要点を日本語で簡潔にまとめてください。',
  });
  calls.length = 0;
  await byName.get('genspark-summarize').handler(inv('https://example.com/doc.pdf 何が書いてある？'));
  assert.deepEqual(calls[0].toolArgs, { url: 'https://example.com/doc.pdf', question: '何が書いてある？' });
});

test('genspark-maps / genspark-analyze-media の引数変換', async () => {
  const { byName, calls } = harness({});
  await byName.get('genspark-maps').handler(inv('東京駅周辺のカフェ'));
  assert.deepEqual(calls[0].toolArgs, { query_type: 'search', engine: 'maps', query: '東京駅周辺のカフェ' });
  await byName.get('genspark-analyze-media').handler(inv('https://example.com/cat.jpg この猫は何をしている？'));
  assert.deepEqual(calls[1].toolArgs, { image_urls: ['https://example.com/cat.jpg'], instruction: 'この猫は何をしている？' });
  await byName.get('genspark-analyze-media').handler(inv('https://example.com/clip.mp4'));
  assert.deepEqual(calls[2].toolArgs, { media_urls: ['https://example.com/clip.mp4'], requirements: 'このメディアの内容を日本語で詳しく説明してください。' });
  assert.equal(calls[2].toolName, 'analyze_media');
});

test('API エラーはエラー結果として返る', async () => {
  const { byName } = harness({
    runResult: {
      code: 0,
      stdout: JSON.stringify({ status: 'error', message: 'rate limited', error_code: 'RATE_LIMIT' }),
      stderr: '',
      ok: true,
    },
  });
  const result = await byName.get('genspark-search').handler(inv('x'));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /Genspark API エラー: rate limited/);
});

test('abort された signal は runner へ渡る', async () => {
  const controller = new AbortController();
  const { byName, calls } = harness({});
  const invocation = { ...inv('x'), signal: controller.signal };
  await byName.get('genspark-search').handler(invocation);
  assert.equal(calls[0].options.signal, controller.signal);
});

// ── /genspark-tools ─────────────────────────────────────────────────────────

test('genspark-tools は引数なしでグループ一覧を返す', async () => {
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-tools').handler(inv(''));
  assert.equal(result.kind, 'success');
  assert.match(result.text, /Genspark ツールカタログ: 全 3 ツール/);
  assert.match(result.text, /## グループ別件数/);
  assert.equal(calls[0].catalog.refresh, false);
});

test('genspark-tools は 1 件に絞れると引数の完全スキーマを返す', async () => {
  const { byName } = harness({});
  const result = await byName.get('genspark-tools').handler(inv('web_search'));
  assert.equal(result.kind, 'success');
  assert.match(result.text, /## web_search/);
  assert.match(result.text, /- q \(必須\): string — query/);
  assert.match(result.text, /実行例: \/genspark-run web_search/);
});

test('genspark-tools は名前の完全一致を最優先で 1 件に絞る', async () => {
  const tools = [
    { name: 'crawler', description: 'Crawl a page', cli: { aliases: ['crawl'] }, parameters: { properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'deep_crawl', description: 'Crawler for whole sites', cli: {}, parameters: { properties: {} } },
  ];
  const { byName } = harness({ tools });
  const result = await byName.get('genspark-tools').handler(inv('crawler'));
  assert.equal(result.kind, 'success');
  assert.match(result.text, /## crawler\b/);
  assert.doesNotMatch(result.text, /グループ別件数/);
});

test('genspark-tools --refresh はキャッシュ更新を要求する', async () => {
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-tools').handler(inv('--refresh crawler'));
  assert.equal(result.kind, 'success');
  assert.equal(calls[0].catalog.refresh, true);
  assert.match(result.text, /## crawler|該当なし/);
});

test('カタログが取れないときはエラーを返す', async () => {
  const { byName } = harness({ catalogError: new Error('カタログを取得できませんでした（exit code: 1）') });
  const result = await byName.get('genspark-tools').handler(inv(''));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /カタログを取得できませんでした/);
});

// ── /genspark-run ───────────────────────────────────────────────────────────

test('genspark-run は読み取り専用で任意ツールを実行する', async () => {
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-run').handler(inv('web_search {"q":"dsh"}'));
  assert.equal(result.kind, 'success');
  assert.equal(calls[1].toolName, 'web_search');
  assert.deepEqual(calls[1].toolArgs, { q: 'dsh' });
  assert.deepEqual(calls[1].options.globalArgs, ['--output', 'json', '--timeout', '600000', '--no-input']);
});

test('genspark-run は引数なしなら使い方を返す', async () => {
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-run').handler(inv(''));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /使い方: \/genspark-run <ツール名> \[JSON引数\]/);
  assert.equal(calls.length, 0);
});

test('genspark-run は壊れた JSON を実行前に拒否する', async () => {
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-run').handler(inv('web_search {q:dsh}'));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /引数の JSON を解釈できませんでした/);
  assert.equal(calls.length, 0);
});

test('genspark-run は存在しないツールを拒否する', async () => {
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-run').handler(inv('nope_tool {}'));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /Genspark に "nope_tool" というツールはありません/);
  assert.match(result.text, /CLI 内蔵の読み取りコマンド me は実行できます/);
  assert.equal(calls.filter((call) => call.toolName).length, 0);
});

test('genspark-run はカタログに載らない読み取り専用の内蔵コマンド（me）を実行できる', async () => {
  const { byName, calls } = harness({ runResult: okData({ email: 'backorz@gmail.com' }) });
  const result = await byName.get('genspark-run').handler(inv('me'));
  assert.equal(result.kind, 'success');
  assert.equal(calls[1].toolName, 'me');
  assert.deepEqual(calls[1].toolArgs, {});
});

test('genspark-run は対話必須・要確認の操作を実行しない', async () => {
  const { byName, calls } = harness({});
  const interactive = await byName.get('genspark-run').handler(inv('x_post_tweet {}'));
  assert.equal(interactive.kind, 'error');
  assert.match(interactive.text, /対話必須の操作/);

  const gated = await byName.get('genspark-run').handler(inv('slack_send {}'));
  assert.equal(gated.kind, 'error');
  assert.match(gated.text, /確認が必要な操作です/);
  assert.match(gated.text, /genspark_run ツール（approve_write: true）/);
  assert.equal(calls.filter((call) => call.toolName).length, 0);
});

// ── 添付ファイル（コンポーザの画像・ファイル） ─────────────────────────────

test('genspark-analyze-media は添付画像をホストパスへ解決して understand_images に渡す', async () => {
  const { byName, calls } = harness({});
  const store = { imageHostPath: () => 'C:\\tmp\\test_cat.jpg' };
  const result = await byName.get('genspark-analyze-media').handler(invAttached('', [imageBlock()], store));
  assert.equal(result.kind, 'success');
  assert.equal(calls[0].toolName, 'understand_images');
  assert.deepEqual(calls[0].toolArgs, {
    image_urls: ['C:\\tmp\\test_cat.jpg'],
    instruction: 'このメディアの内容を日本語で詳しく説明してください。',
  });
});

test('genspark-analyze-media は添付＋指示文を指示として渡す（入力はメディア指定として解釈しない）', async () => {
  const { byName, calls } = harness({});
  const store = { imageHostPath: () => 'C:\\tmp\\a.jpg' };
  await byName.get('genspark-analyze-media').handler(invAttached('この猫は何をしている？', [imageBlock()], store));
  assert.deepEqual(calls[0].toolArgs, { image_urls: ['C:\\tmp\\a.jpg'], instruction: 'この猫は何をしている？' });
});

test('添付ストアが無ければ CLI を起動せず日本語で案内する', async () => {  const { byName, calls } = harness({});
  const result = await byName.get('genspark-analyze-media').handler({
    rawInput: '',
    commandId: 'c3',
    attachments: [imageBlock()],
    signal: undefined,
    agent: { session: { header: { cwd: process.cwd() } } },
  });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /attachments サービスがありません/);
  assert.equal(calls.length, 0);
});

test('プラグインの ctx 経由でも添付を解決できる（agent に ctx が無いホスト向け）', async () => {
  const store = { imageHostPath: () => 'C:\\tmp\\from-ctx.jpg' };
  const ctx = { get: (name) => (name === 'attachments' ? store : undefined) };
  const { byName, calls } = harness({ ctx });
  const result = await byName.get('genspark-analyze-media').handler({
    rawInput: '',
    commandId: 'c4',
    attachments: [imageBlock()],
    signal: undefined,
    agent: { session: { header: { cwd: process.cwd() } } },
  });
  assert.equal(result.kind, 'success');
  assert.deepEqual(calls[0].toolArgs.image_urls, ['C:\\tmp\\from-ctx.jpg']);
});

test('拡張子なしのホストパス（実ストアの画像）は拡張子付きで複製する', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'genspark-attach-copy-'));
  const objectsDir = join(dir, 'objects', 'ab');
  mkdirSync(objectsDir, { recursive: true });
  const hostPath = join(objectsDir, 'ab'.padEnd(64, 'c'));
  writeFileSync(hostPath, 'normalized-jpeg-bytes');
  const store = { imageHostPath: () => hostPath };
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-analyze-media').handler(invAttached('', [imageBlock()], store, dir));
  assert.equal(result.kind, 'success');
  const used = calls[0].toolArgs.image_urls[0];
  assert.notEqual(used, hostPath, '拡張子の無いパスをそのまま渡している');
  assert.match(used, /\.jpg$/);
  assert.equal(existsSync(used), true);
  assert.equal(readFileSync(used, 'utf8'), 'normalized-jpeg-bytes');
});

test('ホストパスが取れない添付は readImage のバイト列を genspark-out/attachments へ書き出す', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'genspark-attach-'));
  const store = {
    imageHostPath: () => undefined,
    fileHostPath: () => undefined,
    readImage: async () => ({ data: Buffer.from('fake-image-bytes') }),
  };
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-analyze-media').handler(invAttached('', [imageBlock()], store, dir));
  assert.equal(result.kind, 'success');
  const written = existsSync(join(dir, 'genspark-out', 'attachments'))
    ? readdirSync(join(dir, 'genspark-out', 'attachments'))
    : [];
  assert.equal(written.length, 1, '添付の実体が保存されていない');
  assert.match(written[0], /\.jpg$/);
  assert.equal(calls[0].toolArgs.image_urls[0], join(dir, 'genspark-out', 'attachments', written[0]));
});

test('genspark-image / genspark-video は添付を image_urls に載せる', async () => {
  const { byName, calls } = harness({});
  const store = { imageHostPath: () => 'C:\\tmp\\ref.png' };
  await byName.get('genspark-image').handler(invAttached('make it blue', [imageBlock('sha256:i2', 'ref.png')], store));
  assert.equal(calls[0].toolName, 'image_generation');
  assert.deepEqual(calls[0].toolArgs.image_urls, ['C:\\tmp\\ref.png']);
  assert.equal(calls[0].toolArgs.query, 'make it blue');

  await byName.get('genspark-video').handler(invAttached('', [imageBlock('sha256:i2', 'ref.png')], store));
  assert.equal(calls[1].toolName, 'video_generation');
  assert.deepEqual(calls[1].toolArgs.image_urls, ['C:\\tmp\\ref.png']);
  assert.match(calls[1].toolArgs.query, /Animate the reference image/);
  assert.equal(calls[1].toolArgs.model, 'kling/v3');
});

test('genspark-summarize / genspark-crawl は添付ファイルを対象にする', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'genspark-attach-doc-'));
  const doc = join(dir, 'report.pdf');
  writeFileSync(doc, 'fake-pdf');
  const store = { fileHostPath: () => doc };
  const { byName, calls } = harness({});
  await byName.get('genspark-summarize').handler(invAttached('要点は？', [fileBlock()], store, dir));
  assert.equal(calls[0].toolName, 'summarize_large_document');
  assert.deepEqual(calls[0].toolArgs, { url: doc, question: '要点は？' });

  await byName.get('genspark-crawl').handler(invAttached('', [fileBlock()], store, dir));
  assert.equal(calls[1].toolName, 'crawler');
  assert.deepEqual(calls[1].toolArgs, { url: doc });
});

test('メディア解析の結果は一覧整形せず分析本文を出す', async () => {
  const { byName } = harness({
    runResult: {
      code: 0,
      stdout: JSON.stringify({
        status: 'ok',
        message: 'success',
        data: { results: [{ url: 'https://www.genspark.ai/api/files/s/x', result: '茶トラ猫がテーブルに座っています。', validate: true }] },
      }),
      stderr: '',
      ok: true,
    },
  });
  const store = { imageHostPath: () => 'C:\\tmp\\a.jpg' };
  const result = await byName.get('genspark-analyze-media').handler(invAttached('', [imageBlock()], store));
  assert.equal(result.kind, 'success');
  assert.match(result.text, /茶トラ猫がテーブルに座っています。/);
  assert.equal(/"validate"/.test(result.text), false);
});

// ── /genspark（状態表示） ───────────────────────────────────────────────────

test('genspark は接続状態・アカウント・ツール数・使い方を返す', async () => {
  const { byName, calls } = harness({
    runResult: okData({ email: 'backorz@gmail.com', name: 'mkgm', plan: 'plus', credit_balance: 8521 }),
  });
  const result = await byName.get('genspark').handler(inv(''));
  assert.equal(result.kind, 'success');
  assert.match(result.text, /CLI エントリ: C:\\fake/);
  assert.match(result.text, /実行ランタイム: C:\\Program Files\\nodejs\\node.exe（auto）/);
  assert.match(result.text, /アカウント: backorz@gmail\.com（mkgm） \/ plan plus/);
  assert.match(result.text, /残クレジット: 8521/);
  assert.match(result.text, /ツール: 3 件/);
  assert.match(result.text, /昇格ツール: search=検索・調査 6 ツール \/ media=生成メディア 4 ツール/);
  assert.match(result.text, /使えるコマンド:/);
  assert.match(result.text, /\/genspark-image 生成したい画像の説明/);
  // 引数なしツール（me）は --args-file を付けずに実行される
  assert.deepEqual(calls[0].toolName, 'me');
  assert.deepEqual(calls[0].toolArgs, {});
});

test('genspark はアカウント取得に失敗しても状態表示を続ける', async () => {
  const { byName } = harness({
    runResult: { code: 1, stdout: '', stderr: '[ERROR] not logged in', ok: false },
  });
  const result = await byName.get('genspark').handler(inv(''));
  assert.equal(result.kind, 'success');
  assert.match(result.text, /アカウント: 取得できませんでした/);
  assert.match(result.text, /ツール: 3 件/);
});

// ── コマンド結果のモデルへの引き継ぎ（agent.followup） ──────────────────────
// ホストコマンドの結果は既定では画面のコマンド欄にしか出ないため、そのままだと AI が内容を
// 解釈できない。実行後に agent.followup で結果を次のターンへ渡す（設定 commandFollowup）。

test('コマンド結果は agent.followup でモデルへ渡される', async () => {
  const seen = [];
  const { byName } = harness({});
  const result = await byName
    .get('genspark-search')
    .handler(inv('東京 天気', process.cwd(), followupAgent(seen)));
  await tick();

  assert.equal(result.kind, 'success');
  assert.equal(seen.length, 1);
  // セッション形式 V4 の正準 producer kind（`kind: 'plugin'` は廃止済みで拒否される）
  assert.deepEqual(seen[0].source, { kind: 'plugin:dsh-genspark' });
  const text = seen[0].content[0].text;
  assert.match(text, /Genspark のコマンド実行結果です（\/genspark-search 東京 天気）/);
  assert.match(text, /状態: 成功/);
  // 結果本文がそのまま入っている（画面のコマンド欄と同じ内容をモデルが読める）
  assert.match(text, /echo/);
  // 同じ内容を繰り返させない指示も入れる
  assert.match(text, /同じ内容を繰り返さず/);
});

test('エラー結果も引き継ぐ（AI が原因を説明できるように）', async () => {
  const seen = [];
  const { byName } = harness({});
  const result = await byName.get('genspark-search').handler(inv('', process.cwd(), followupAgent(seen)));
  await tick();

  assert.equal(result.kind, 'error');
  assert.equal(seen.length, 1);
  const text = seen[0].content[0].text;
  assert.match(text, /状態: エラー/);
  assert.match(text, /入力が必要です/);
});

test('commandFollowup: false ならモデルへ渡さない（従来どおり結果はコマンド欄だけ）', async () => {
  const seen = [];
  const { byName } = harness({ config: { commandFollowup: false } });
  const result = await byName
    .get('genspark-search')
    .handler(inv('東京 天気', process.cwd(), followupAgent(seen)));
  await tick();

  assert.equal(result.kind, 'success');
  assert.equal(seen.length, 0);
});

test('agent が followup を持たないホストでもコマンドは壊れない', async () => {
  const { byName } = harness({});
  // inv の既定 agent は { session: { header: { cwd } } } のみ（followup 無し）
  const result = await byName.get('genspark-search').handler(inv('東京 天気'));
  assert.equal(result.kind, 'success');
});

test('followup が失敗してもコマンド結果は返り、ログに残る', async () => {
  const logs = [];
  const { byName } = harness({ log: (message) => logs.push(message) });
  const agent = {
    session: { header: { cwd: process.cwd() } },
    followup() {
      throw new Error('driver gone');
    },
  };
  const result = await byName.get('genspark-search').handler(inv('東京 天気', process.cwd(), agent));
  await tick();

  assert.equal(result.kind, 'success');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /コマンド結果の引き継ぎに失敗しました（\/genspark-search）: driver gone/);
});

// 実機で「コマンドが完了せず、結果も AI の応答も出ない」状態を観測したため、
// 引き継ぎが返らない/拒否される場合でもコマンドが必ず完結することを固定する。

test('followup が返らない Promise でもコマンド結果はすぐ返る', async () => {
  const { byName } = harness({});
  const agent = {
    session: { header: { cwd: process.cwd() } },
    followup() {
      return new Promise(() => {}); // 永久に settle しない
    },
  };
  const result = await byName.get('genspark-search').handler(inv('東京 天気', process.cwd(), agent));
  assert.equal(result.kind, 'success');
});

test('followup の Promise が拒否されてもログに残して続行する', async () => {
  const logs = [];
  const { byName } = harness({ log: (message) => logs.push(message) });
  const agent = {
    session: { header: { cwd: process.cwd() } },
    followup() {
      return Promise.reject(new Error('driver rejected'));
    },
  };
  const result = await byName.get('genspark-search').handler(inv('東京 天気', process.cwd(), agent));
  await tick();

  assert.equal(result.kind, 'success');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /コマンド結果の引き継ぎに失敗しました（\/genspark-search）: driver rejected/);
});

// ── 長時間かかるコマンドの早期リターン（入力欄の凍結を短くする） ──────────────
// ホストはコマンドが完了するまで送信トランザクション中（phase = submitting）で、
// その間コンポーザは編集不可・下書きは保持される
// （dsh-client-ui-conversation/lib/client.js:17292 の machineBusy と :17295 の editable。
// 実測では画像生成が 8 秒かかり、その間ずっと入力欄が凍結していた）。
// commandInlineWaitMs を過ぎたらコマンドを完了させ、結果は引き継ぎでチャットへ届ける。

/** 手動で解決できる Promise（長時間かかるコマンドを再現する）。 */
function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** 早期リターン後の背景実行が終わるまで待つ。 */
const settleAll = () => new Promise((resolve) => setTimeout(resolve, 20));

test('既定では長時間かかるコマンドを待たず、結果は引き継ぎで届く', async () => {
  const seen = [];
  const gate = deferred();
  const { byName } = harness({
    config: { commandInlineWaitMs: 20 },
    onRun: async () => {
      await gate.promise;
      return okData({ echo: 'slow' });
    },
  });
  const result = await byName
    .get('genspark-search')
    .handler(inv('東京 天気', process.cwd(), followupAgent(seen)));

  assert.equal(result.kind, 'success');
  assert.match(result.text, /結果はこのあとチャットに届きます/);
  assert.equal(seen.length, 0); // まだ実行中なので引き継ぎは来ていない

  gate.resolve();
  await settleAll();
  assert.equal(seen.length, 1);
  const text = seen[0].content[0].text;
  assert.match(text, /状態: 成功/);
  assert.match(text, /slow/); // 結果本文はチャット側に載る
});

test('生成コマンドの早期リターン文言に種別ごとの待ち時間の目安が入る', async () => {
  const gate = deferred();
  const seen = [];
  const { byName } = harness({
    config: { commandInlineWaitMs: 20 },
    onRun: async () => {
      await gate.promise;
      return okData({ url: 'https://example.com/x.mp4' });
    },
  });
  const result = await byName
    .get('genspark-video')
    .handler(inv('うさぎカフェ', process.cwd(), followupAgent(seen)));

  assert.equal(result.kind, 'success');
  assert.match(result.text, /動画を生成中です（目安 1〜2 分/);
  assert.match(result.text, /結果はこのあとチャットに届きます/);

  gate.resolve();
  await settleAll();
  assert.equal(seen.length, 1);
});

test('生成コマンドは既定で入力直後に「Genspark に送信中です」を返す', async () => {
  const gate = deferred();
  const seen = [];
  const { byName } = harness({
    onRun: async () => {
      await gate.promise;
      return okData({ url: 'https://example.com/x.mp4' });
    },
  });
  const started = Date.now();
  const result = await byName
    .get('genspark-video')
    .handler(inv('うさぎカフェ', process.cwd(), followupAgent(seen)));
  const elapsed = Date.now() - started;

  assert.equal(result.kind, 'success');
  assert.match(result.text, /Genspark に送信中です（目安 1〜2 分/);
  assert.match(result.text, /結果はこのあとチャットに届きます/);
  assert.ok(elapsed < 1000, `受付メッセージが遅い: ${elapsed}ms`);
  assert.equal(seen.length, 0); // 結果はまだ来ていない

  gate.resolve();
  await settleAll();
  assert.equal(seen.length, 1);
  assert.match(seen[0].content[0].text, /状態: 成功/);
});

test('早期リターン後に失敗した実行もエラーとして引き継ぐ', async () => {
  const seen = [];
  const gate = deferred();
  const { byName } = harness({
    config: { commandInlineWaitMs: 20 },
    onRun: async () => {
      await gate.promise;
      return { code: 1, stdout: '', stderr: 'boom', ok: false };
    },
  });
  const result = await byName
    .get('genspark-search')
    .handler(inv('東京 天気', process.cwd(), followupAgent(seen)));
  assert.match(result.text, /結果はこのあとチャットに届きます/);

  gate.resolve();
  await settleAll();
  assert.equal(seen.length, 1);
  assert.match(seen[0].content[0].text, /状態: エラー/);
});

test('commandInlineWaitMs: 0 なら従来どおり完了まで待って結果を返す', async () => {
  const seen = [];
  const gate = deferred();
  const { byName } = harness({
    config: { commandInlineWaitMs: 0 },
    onRun: async () => {
      await gate.promise;
      return okData({ echo: 'slow' });
    },
  });
  const pending = byName.get('genspark-search').handler(inv('東京 天気', process.cwd(), followupAgent(seen)));
  gate.resolve();
  const result = await pending;

  assert.equal(result.kind, 'success');
  assert.match(result.text, /slow/); // 結果はコマンド欄に出る
  assert.doesNotMatch(result.text, /結果はこのあとチャットに届きます/);
  await settleAll();
  assert.equal(seen.length, 1);
});

test('commandFollowup: false なら早期リターンしない（届ける手段が無いため）', async () => {
  const seen = [];
  const gate = deferred();
  const { byName } = harness({
    config: { commandFollowup: false, commandInlineWaitMs: 20 },
    onRun: async () => {
      await gate.promise;
      return okData({ echo: 'slow' });
    },
  });
  const pending = byName.get('genspark-search').handler(inv('東京 天気', process.cwd(), followupAgent(seen)));
  gate.resolve();
  const result = await pending;

  assert.match(result.text, /slow/);
  assert.equal(seen.length, 0);
});

test('agent が followup を持たないホストでも早期リターンしない（結果を失わせない）', async () => {
  const gate = deferred();
  const { byName } = harness({
    config: { commandInlineWaitMs: 20 },
    onRun: async () => {
      await gate.promise;
      return okData({ echo: 'slow' });
    },
  });
  const pending = byName.get('genspark-search').handler(inv('東京 天気'));
  gate.resolve();
  const result = await pending;

  assert.match(result.text, /slow/);
});

test('早期リターン後は呼び出し元の signal を転送しない（背景実行を巻き込まない）', async () => {
  const seen = [];
  const gate = deferred();
  let captured;
  const { byName } = harness({
    config: { commandInlineWaitMs: 20 },
    onRun: async ({ options }) => {
      captured = options.signal;
      await gate.promise;
      return okData({ echo: 'slow' });
    },
  });
  const controller = new AbortController();
  const invocation = { ...inv('東京 天気', process.cwd(), followupAgent(seen)), signal: controller.signal };
  const result = await byName.get('genspark-search').handler(invocation);

  assert.match(result.text, /結果はこのあとチャットに届きます/);
  assert.ok(captured, 'runner へ signal が渡る');
  assert.notEqual(captured, controller.signal); // 転送用の別 signal
  controller.abort(new Error('rpc settled')); // 早期リターン後に RPC 側が abort しても
  assert.equal(captured.aborted, false); // 背景の実行は生きたまま

  gate.resolve();
  await settleAll();
  assert.equal(seen.length, 1);
  assert.match(seen[0].content[0].text, /状態: 成功/);
});

test('待っている間に abort されたら転送する（実行中のキャンセルは効く）', async () => {
  const seen = [];
  const gate = deferred();
  let captured;
  const { byName } = harness({
    config: { commandInlineWaitMs: 500 },
    onRun: async ({ options }) => {
      captured = options.signal;
      await gate.promise;
      return okData({ echo: 'slow' });
    },
  });
  const controller = new AbortController();
  const invocation = { ...inv('東京 天気', process.cwd(), followupAgent(seen)), signal: controller.signal };
  const pending = byName.get('genspark-search').handler(invocation);
  await tick();
  controller.abort(new Error('cancel'));
  assert.equal(captured.aborted, true);

  gate.resolve();
  await pending;
});

// ── 補助関数 ────────────────────────────────────────────────────────────────

test('autoSavePath は genspark-out 配下の絶対パスを作る（日本語入力でも壊れない）', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-genspark-cmd-'));
  const path = autoSavePath(cwd, 'image', '赤い立方体', 'png');
  assert.ok(path.startsWith(join(cwd, 'genspark-out')));
  assert.match(path, /-image\.png$/);
  mkdirSync(join(cwd, 'genspark-out'), { recursive: true });
});

test('humanizeData は一覧が無ければ null を返す（JSON 表示へフォールバック）', () => {
  assert.equal(humanizeData({ email: 'a@example.com', plan: 'plus' }), null);
  assert.equal(humanizeData(undefined), null);
  assert.match(humanizeData({ images: [{ url: 'https://example.com/i.png' }] }), /images: 1 件/);
});

test('humanizeData はネストした項目（model_info）からタイトルと配列を拾う', () => {
  const text = humanizeData({
    success: true,
    count: 1,
    models: [
      {
        model_name: 'kling/v3',
        model_info: {
          name: 'Kling V3',
          capabilities: ['text_to_video', 'image_to_video'],
          strengths: ['Latest Kling V3 model'],
        },
      },
    ],
  });
  assert.match(text, /models: 1 件/);
  // 直接のキー（model_name）が優先。ネストした name は直接のキーが無いときだけ使う
  assert.match(text, /1\. kling\/v3/);
  assert.match(text, /capabilities: text_to_video \/ image_to_video/);
  assert.match(text, /strengths: Latest Kling V3 model/);
});

test('humanizeData は拾える項目が無いときだけ JSON を 1 行で出す', () => {
  const text = humanizeData({ results: [{ unknown_field: 42 }] });
  assert.match(text, /results: 1 件/);
  assert.match(text, /\{"unknown_field":42\}/);
});

/** モデル enum を持つ最小カタログ。 */
const MODEL_TOOLS = [
  { name: 'image_generation', parameters: { properties: { model: { enum: ['nano-banana-2.1', 'gpt-image-2'] } } } },
  { name: 'video_generation', parameters: { properties: { model: { enum: ['kling/v3', 'gemini/veo3.1'] } } } },
  { name: 'audio_generation', parameters: { properties: { model: { enum: ['elevenlabs/v4-tts', 'elevenlabs/music'] } } } },
  { name: 'audio_transcribe', parameters: { properties: { model: { enum: ['whisper-1'] } } } },
];

test('/genspark-models はカタログの model enum を種類ごとに並べる', async () => {
  const { byName } = harness({ tools: MODEL_TOOLS });
  const result = await byName.get('genspark-models').handler(inv(''));
  assert.equal(result.kind, 'success');
  assert.match(result.text, /画像生成 — 2 モデル（\/genspark-image \/ genspark_generate_image）/);
  assert.match(result.text, /nano-banana-2\.1 \/ gpt-image-2/);
  assert.match(result.text, /動画生成 — 2 モデル/);
  assert.match(result.text, /kling\/v3 \/ gemini\/veo3\.1/);
  assert.match(result.text, /文字起こし — 1 モデル/);
});

test('/genspark-models は日本語の種類指定と id の部分一致で絞れる', async () => {
  const { byName } = harness({ tools: MODEL_TOOLS });
  const models = byName.get('genspark-models');

  const video = await models.handler(inv('動画'));
  assert.match(video.text, /kling\/v3/);
  assert.equal(/nano-banana/.test(video.text), false);

  const kling = await models.handler(inv('kling'));
  assert.match(kling.text, /kling\/v3/);
  assert.equal(/elevenlabs/.test(kling.text), false);

  const missing = await models.handler(inv('存在しないモデル'));
  assert.match(missing.text, /該当するモデルが見つかりませんでした/);
});

test('/genspark-models はカタログ取得の失敗をエラーで返す', async () => {
  const { byName } = harness({ tools: MODEL_TOOLS, catalogError: new Error('boom') });
  const result = await byName.get('genspark-models').handler(inv(''));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /モデル一覧を取得できませんでした: boom/);
});
