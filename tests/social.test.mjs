/**
 * ソーシャルメディア（lib/social.js・social カテゴリの昇格ツール・振り分けコマンド）の単体テスト。
 * ホスト不要・ネットワーク不要。実行: node tests/social.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { describeToolFull, toolInvocation, invocationLabel } from '../lib/catalog.js';
import { buildGensparkCommands } from '../lib/commands.js';
import { PROMOTED_TOOLS, buildPromotedTools, promotedSummary, socialRetryArgs } from '../lib/promoted.js';
import { autoAction, formatSocialResult, normalizeSocialArgs, postUrlOf, socialFailure } from '../lib/social.js';

const EXEC = { agent: { session: { header: { cwd: process.cwd() } } } };

/** followup を受け取る擬似エージェント（既存の会話＝ receipt は送らない）。 */
const followupAgent = (seen) => ({
  session: { header: { cwd: process.cwd() }, snapshotEvents: () => [{ type: 'turn/start' }] },
  followup(message) {
    seen.push(message);
  },
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 昇格ツールを集める（runner は記録だけ。runResults を渡すと順に返す＝再試行の検証用）。 */
function collect({ categories = ['social'], runResult, runResults, calls = [] } = {}) {
  let index = 0;
  return buildPromotedTools({
    defineTool: (spec) => spec,
    getConfig: () => ({
      timeoutMs: 600000,
      maxOutputChars: 100000,
      promotedCategories: categories,
      // 再試行の待ちを 0 にしてテストを速くする
      socialRetryDelayMs: 0,
    }),
    runner: {
      async runTool(toolName, toolArgs, options) {
        calls.push({ toolName, toolArgs, options });
        const next = runResults ? runResults[index++] : runResult;
        return (
          next ?? {
            code: 0,
            stdout: JSON.stringify({ status: 'ok', message: 'success', data: { results: [] } }),
            stderr: '',
            ok: true,
          }
        );
      },
    },
    categories,
  });
}

// ── CLI の正規コマンド名の解決 ────────────────────────────────────────────────

test('toolInvocation: グループ付き／パス付き／素のツール名を CLI の正規形へ解決する', () => {
  // グループ付き（social_twitter → gsk social twitter）
  assert.deepEqual(toolInvocation({ name: 'social_twitter', cli: { group: 'social' } }), ['social', 'twitter']);
  assert.deepEqual(toolInvocation({ name: 'x_search_tweets', cli: { group: 'x' } }), ['x', 'search_tweets']);
  assert.deepEqual(toolInvocation({ name: 'notion_mcp_tools', cli: { group: 'notion_mcp' } }), ['notion_mcp', 'tools']);
  assert.deepEqual(
    toolInvocation({ name: 'social_reddit', cli: { group: 'social', subcommand: 'reddit' } }),
    ['social', 'reddit'],
  );
  // パス付き（task create / telephony call dial）
  assert.deepEqual(toolInvocation({ name: 'create_task', cli: { path: ['task', 'create'], group: 'task' } }), ['task', 'create']);
  assert.deepEqual(
    toolInvocation({ name: 'phone_call', cli: { path: ['telephony', 'call', 'dial'] } }),
    ['telephony', 'call', 'dial'],
  );
  // 素のツール名
  assert.deepEqual(toolInvocation({ name: 'web_search', cli: {} }), ['web_search']);
  assert.deepEqual(toolInvocation({ name: 'me', cli: { group: null } }), ['me']);
});

test('invocationLabel: 人間が読めるコマンド表記を返す', () => {
  assert.equal(invocationLabel({ name: 'social_twitter', cli: { group: 'social' } }), 'gsk social twitter');
  assert.equal(invocationLabel({ name: 'web_search', cli: {} }), 'gsk web_search');
});

test('describeToolFull: 実行コマンドを併記する（グループ付きでも迷わない）', () => {
  const text = describeToolFull({
    name: 'social_twitter',
    description: 'Search X',
    cli: { group: 'social' },
    parameters: { properties: { action: { type: 'string' } }, required: ['action'] },
  });
  assert.match(text, /- 実行: gsk social twitter/);
});

// ── action の自動判定・引数の正規化 ─────────────────────────────────────────

test('autoAction: @handle はその人の投稿、話題は投稿検索へ倒す', () => {
  // get_user は id / 名前しか返らないため auto では選ばない（実測）
  assert.equal(autoAction('x', '@elonmusk'), 'get_posts_by_author');
  assert.equal(autoAction('instagram', '@natgeo'), 'get_posts_by_user');
  assert.equal(autoAction('reddit', '@foo'), 'get_user');
  assert.equal(autoAction('x', 'from:elonmusk'), 'get_posts_by_author');
  assert.equal(autoAction('x', 'Genspark'), 'search_posts');
  assert.equal(autoAction('reddit', 'local llm'), 'search_posts');
  assert.equal(autoAction('x', ''), 'search_posts');
});

test('normalizeSocialArgs: @ を落とし、既定値を補い、CLI 専用キーを除く', () => {
  assert.deepEqual(normalizeSocialArgs('x', 'get_user', { action: 'get_user', query: '@elonmusk', raw: true }), {
    action: 'get_user',
    query: 'elonmusk',
  });
  assert.equal(normalizeSocialArgs('x', 'get_user_connections', { query: 'elonmusk' }).connection_type, 'followers');
  assert.equal(normalizeSocialArgs('x', 'get_post_interacting_users', { post_id: '1' }).interaction_type, 'retweeters');
  assert.equal(normalizeSocialArgs('instagram', 'get_post_interacting_users', { post_id: '1' }).interaction_type, 'likers');
  assert.equal(normalizeSocialArgs('x', 'search_posts', { query: 'x' }).extra, undefined);
});

// ── 整形 ─────────────────────────────────────────────────────────────────────

const X_DATA = {
  results: [
    { id: '111', text: 'Genspark の動画生成', author_username: 'alice', impression_count: 1200, created_at_date: '2026-10-15T00:00:00.000Z' },
    { id: '222', text: 'line1\\nline2', author_username: 'bob', impression_count: 5, created_at_date: '2026-10-14T00:00:00.000Z' },
  ],
  pagination: { page: 1, total_rows: 0 },
};

test('formatSocialResult: X の投稿を件数・投稿者・表示回数・URL 付きで整形する', () => {
  const text = formatSocialResult(X_DATA, { platform: 'x', action: 'search_posts', query: 'Genspark' });
  assert.match(text, /X（Twitter）の投稿検索: 「Genspark」 — 2 件/);
  assert.match(text, /1\. @alice · 2026-10-15 · 表示 1,200 回/);
  assert.match(text, /https:\/\/x\.com\/alice\/status\/111/);
  // 生データの `\n`（バックスラッシュ + n）も 1 行に潰す
  assert.match(text, /line1 \/ line2/);
  assert.equal(text.includes('\\n'), false);
});

test('formatSocialResult: limit で切り、サーバー返却件数と表示件数を区別して案内する', () => {
  const text = formatSocialResult(X_DATA, { platform: 'x', action: 'search_posts', query: 'q', limit: 1 });
  assert.match(text, /サーバー返却 2 件中 1 件を表示（残り 1 件。limit で増やす／raw: true で全件の生データ）/);
  assert.equal(text.includes('@bob'), false);
});

test('formatSocialResult: Instagram はメディア種別・反応数・code_url を出す', () => {
  const text = formatSocialResult(
    {
      results: [
        {
          id: 'abc',
          username: 'startup',
          full_name: 'Startup Grind',
          caption: 'Wen Sang took Genspark from zero to $250M ARR',
          media_type: 'video',
          code_url: 'https://instagram.com/p/Db3YsDCqDsC',
          like_count: 27,
          comment_count: 4,
          video_play_count: 1366,
          created_at_date: '2026-08-10',
        },
      ],
    },
    { platform: 'instagram', action: 'search_posts', query: 'genspark' },
  );
  assert.match(text, /Instagramの投稿検索/);
  assert.match(text, /@startup（Startup Grind）/);
  assert.match(text, /♥ 27 💬 4 ▶ 1,366/);
  assert.match(text, /https:\/\/instagram\.com\/p\/Db3YsDCqDsC/);
});

test('formatSocialResult: Reddit はサブレディット・投稿者・URL を組み立てる', () => {
  const text = formatSocialResult(
    {
      results: [
        { id: '1x7rkcr', title: 'RAMDeck: pool RAM across old PCs', author_username: 'someone', subreddit_name: 'kickstarter', created_at_date: '2026-10-16' },
      ],
    },
    { platform: 'reddit', action: 'search_posts', query: 'local llm' },
  );
  assert.match(text, /r\/kickstarter · u\/someone · 2026-10-16/);
  assert.match(text, /https:\/\/www\.reddit\.com\/r\/kickstarter\/comments\/1x7rkcr/);
});

test('formatSocialResult: ユーザー行・プロフィールは @handle 形式で出す', () => {
  const users = formatSocialResult(
    { results: [{ id: '496236543', username: 'edwardfelix05', name: 'Gen Spark Uyi' }] },
    { platform: 'x', action: 'search_users', query: 'genspark' },
  );
  assert.match(users, /@edwardfelix05（Gen Spark Uyi）· id 496236543/);

  const profile = formatSocialResult(
    { result: { id: '44196397', username: 'elonmusk', name: 'Elon Musk', status: 'success' } },
    { platform: 'x', action: 'get_user', query: 'elonmusk' },
  );
  assert.match(profile, /X（Twitter）のアカウント基本情報/);
  assert.match(profile, /@elonmusk（Elon Musk）/);
});

test('formatSocialResult: 空結果は生 JSON ではなく定型文を返す', () => {
  const text = formatSocialResult(
    { results: [], pagination: { page: 1, total_pages: 0, total_rows: 0 } },
    { platform: 'reddit', action: 'search_posts', query: 'zzz' },
  );
  assert.match(text, /該当する結果はありませんでした（サーバー返却 0 件）/);
  assert.equal(text.includes('"results"'), false);
  assert.equal(text.includes('pagination'), false);
});

test('formatSocialResult: 投稿は新しい順に並べ替える（返却順が時系列でないため）', () => {
  const text = formatSocialResult(
    {
      results: [
        { id: 'a', text: 'old', author_username: 'u1', created_at_date: '2026-08-23' },
        { id: 'b', text: 'newest', author_username: 'u2', created_at_date: '2026-10-18' },
        { id: 'c', text: 'mid', author_username: 'u3', created_at_date: '2026-10-01' },
      ],
    },
    { platform: 'x', action: 'get_posts_by_author', query: 'u2' },
  );
  const order = [...text.matchAll(/https:\/\/x\.com\/u\d\/status\/(\w)/g)].map((match) => match[1]);
  assert.deepEqual(order, ['b', 'c', 'a']);
});

test('formatSocialResult: Reddit の {result:{post,comments}} をタイトル・URL・コメントに整形する', () => {
  const text = formatSocialResult(
    {
      result: {
        post: { id: '1x7rkcr', title: 'RAMDeck: pool RAM across old PCs', author_username: 'Medicine_Blogscanner', subreddit_name: 'kickstarter' },
        comments: [
          { id: 'c1', body: 'Looks promising', author_username: 'someone', created_at_date: '2026-10-16', score: 12 },
        ],
      },
    },
    { platform: 'reddit', action: 'get_post_with_comments', limit: 25 },
  );
  assert.match(text, /Redditの投稿とコメント: 「RAMDeck: pool RAM across old PCs」/);
  assert.match(text, /https:\/\/www\.reddit\.com\/r\/kickstarter\/comments\/1x7rkcr/);
  assert.match(text, /コメント: 1 件/);
  assert.match(text, /u\/someone · 2026-10-16（\+12） — Looks promising/);
});

test('formatSocialResult: Reddit の {result:{subreddit,posts}} をサブレディット見出し＋投稿に整形する', () => {
  const text = formatSocialResult(
    {
      result: {
        subreddit: { id: '81eyvm', display_name: 'LocalLLaMA', subscribers_count: 851787 },
        posts: [
          { id: 'p1', title: 'older', author_username: 'a', subreddit_name: 'LocalLLaMA', created_at_date: '2026-10-11' },
          { id: 'p2', title: 'newer', author_username: 'b', subreddit_name: 'LocalLLaMA', created_at_date: '2026-10-17' },
        ],
      },
    },
    { platform: 'reddit', action: 'get_subreddit_with_posts' },
  );
  assert.match(text, /Redditのサブレディット: r\/LocalLLaMA（購読者 851,787 人）/);
  assert.match(text, /投稿: 2 件（新しい順）/);
  const order = [...text.matchAll(/\/comments\/(p\d)/g)].map((match) => match[1]);
  assert.deepEqual(order, ['p2', 'p1']);
});

test('formatSocialResult: サーバー側の失敗を日本語で説明する', () => {
  const text = formatSocialResult({ result: 'Failed to execute Twitter action' }, { platform: 'x', action: 'count_posts' });
  assert.match(text, /失敗しました/);
  assert.match(text, /action を search_posts \/ search_users \/ get_user/);
  assert.equal(socialFailure({ result: 'Failed to execute Reddit action' }) !== undefined, true);
  assert.equal(socialFailure({ results: [] }), undefined);
});

test('postUrlOf: URL が無い行は id から復元する', () => {
  assert.equal(postUrlOf('x', { id: '1', author_username: 'a' }), 'https://x.com/a/status/1');
  assert.equal(postUrlOf('reddit', { id: 'p1', subreddit_name: 'rust' }), 'https://www.reddit.com/r/rust/comments/p1');
  assert.equal(postUrlOf('x', { id: '1' }), undefined);
  assert.equal(postUrlOf('instagram', { id: '1' }), undefined);
});

// ── 昇格ツール（social カテゴリ） ────────────────────────────────────────────

test('social カテゴリは 3 ツールを登録する', () => {
  const tools = collect();
  assert.deepEqual(tools.map((tool) => tool.name), [
    'genspark_x_search',
    'genspark_instagram_search',
    'genspark_reddit_search',
  ]);
  assert.match(promotedSummary(['search', 'media', 'social']), /social=ソーシャルメディア 3 ツール/);
});

test('build: action 省略時は自動判定し、limit の既定は 25', () => {
  const spec = PROMOTED_TOOLS.find((tool) => tool.name === 'genspark_x_search');
  const built = spec.build({ query: 'Genspark' }, process.cwd());
  assert.equal(built.args.action, 'search_posts');
  assert.equal(built.args.query, 'Genspark');
  assert.equal(built.args.limit, 25);
  assert.deepEqual(built.command, ['social', 'twitter']);
  assert.equal(built.render.limit, 25);
  assert.equal(built.render.raw, false);
});

test('build: @handle はその人の投稿、get_user は明示したときだけ', () => {
  const spec = PROMOTED_TOOLS.find((tool) => tool.name === 'genspark_x_search');
  const author = spec.build({ query: '@elonmusk' }, process.cwd());
  assert.equal(author.args.action, 'get_posts_by_author');
  assert.equal(author.args.query, 'elonmusk');
  const explicitUser = spec.build({ action: 'get_user', query: '@elonmusk' }, process.cwd());
  assert.equal(explicitUser.args.action, 'get_user');
  assert.equal(explicitUser.args.query, 'elonmusk');
  const fromOperator = spec.build({ query: 'from:elonmusk' }, process.cwd());
  assert.equal(fromOperator.args.action, 'get_posts_by_author');
  assert.equal(fromOperator.args.query, 'elonmusk');
});

test('build: 引数の不足・不正は日本語で throw する（CLI を起動しない）', () => {
  const x = PROMOTED_TOOLS.find((tool) => tool.name === 'genspark_x_search');
  assert.throws(() => x.build({ action: 'get_comments' }, process.cwd()), /post_id（または post_ids）が必要です/);
  assert.throws(() => x.build({ action: 'nope', query: 'x' }, process.cwd()), /action は .* のいずれかです/);
  assert.throws(() => x.build({ action: 'search_posts' }, process.cwd()), /には query が必要です/);
  const reddit = PROMOTED_TOOLS.find((tool) => tool.name === 'genspark_reddit_search');
  assert.throws(() => reddit.build({ action: 'get_post_with_comments' }, process.cwd()), /には post_id/);
  const instagram = PROMOTED_TOOLS.find((tool) => tool.name === 'genspark_instagram_search');
  assert.throws(() => instagram.build({ action: 'get_posts_by_ids' }, process.cwd()), /post_id/);
});

test('build: Reddit は sort / time / subreddit を渡す', () => {
  const spec = PROMOTED_TOOLS.find((tool) => tool.name === 'genspark_reddit_search');
  const built = spec.build({ query: 'local llm', sort: 'top', time: 'week', subreddit: 'LocalLLaMA' }, process.cwd());
  assert.equal(built.args.sort, 'top');
  assert.equal(built.args.time, 'week');
  assert.equal(built.args.subreddit, 'LocalLLaMA');
  assert.deepEqual(built.command, ['social', 'reddit']);
});

test('build: 日付は search_posts にだけ送る（非対応 action では落とす＝実測の失敗回避）', () => {
  const spec = PROMOTED_TOOLS.find((tool) => tool.name === 'genspark_x_search');
  const search = spec.build({ query: 'anima', start_date: '2026-10-11', end_date: '2026-10-18' }, process.cwd());
  assert.equal(search.args.start_date, '2026-10-11');
  assert.equal(search.args.end_date, '2026-10-18');
  // @handle は get_posts_by_author（日付非対応）へ倒れるので start_date は落ちる
  const author = spec.build({ query: '@foo', start_date: '2026-10-11' }, process.cwd());
  assert.equal(author.args.action, 'get_posts_by_author');
  assert.equal(author.args.start_date, undefined);
});

test('socialRetryArgs: 失敗時だけ 1 回ぶんの引数を返す（未対応 action は再試行しない）', () => {
  const failed = { result: 'Failed to execute Twitter action' };
  const next = socialRetryArgs({ action: 'search_posts', start_date: 'x', end_date: 'y' }, failed);
  assert.equal(next.action, 'search_posts');
  assert.equal(next.start_date, undefined);
  assert.equal(socialRetryArgs({ action: 'search_posts' }, { results: [] }), null);
  assert.equal(socialRetryArgs({ action: 'count_posts' }, failed), null);
  assert.equal(socialRetryArgs({ action: 'search_subreddits' }, failed), null);
});

test('execute: 一時的な失敗は 1 回だけ自動で再試行する', async () => {
  const calls = [];
  const failure = {
    code: 0,
    ok: true,
    stderr: '',
    stdout: JSON.stringify({ status: 'ok', message: 'success', data: { result: 'Failed to execute Twitter action' } }),
  };
  const recovered = {
    code: 0,
    ok: true,
    stderr: '',
    stdout: JSON.stringify({
      status: 'ok',
      message: 'success',
      data: { results: [{ id: '9', text: 'recovered', author_username: 'carol', created_at_date: '2026-10-18' }] },
    }),
  };
  const tools = collect({ calls, runResults: [failure, recovered] });
  const text = await tools[0].execute({ query: 'Genspark' }, EXEC);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.toolCommand[0], 'social');
  assert.match(text, /recovered/);
  assert.equal(/失敗しました/.test(text), false);
});

test('execute: 再試行しても失敗すれば説明文を返す（2 回で打ち切る）', async () => {
  const calls = [];
  const failure = {
    code: 0,
    ok: true,
    stderr: '',
    stdout: JSON.stringify({ status: 'ok', message: 'success', data: { result: 'Failed to execute Twitter action' } }),
  };
  const tools = collect({ calls, runResults: [failure, failure, failure] });
  const text = await tools[0].execute({ query: 'Genspark' }, EXEC);
  assert.equal(calls.length, 2);
  assert.match(text, /失敗しました/);
  assert.match(text, /自動で 1 回だけ再試行済み/);
});

test('execute: グループ付きコマンドを渡し、応答を整形して返す', async () => {
  const calls = [];
  const tools = collect({
    calls,
    runResult: {
      code: 0,
      stdout: JSON.stringify({
        status: 'ok',
        message: 'success',
        data: { results: [{ id: '1', text: 'hello', author_username: 'alice', created_at_date: '2026-10-15' }] },
      }),
      stderr: '',
      ok: true,
    },
  });
  const text = await tools[0].execute({ query: 'Genspark', limit: 3 }, EXEC);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.toolCommand, ['social', 'twitter']);
  assert.equal(calls[0].toolName, 'social_twitter');
  assert.match(text, /X（Twitter）の投稿検索/);
  assert.match(text, /https:\/\/x\.com\/alice\/status\/1/);
});

test('formatSocialResult: language 指定時は lang が一致する行へ絞る（0 件なら絞らない）', () => {
  const rows = [
    { id: '1', text: '日本語の投稿', author_username: 'a', lang: 'ja', created_at_date: '2026-10-18' },
    { id: '2', text: 'italian anima', author_username: 'b', lang: 'it', created_at_date: '2026-10-17' },
    { id: '3', text: 'no lang field', author_username: 'c', created_at_date: '2026-10-16' },
  ];
  const filtered = formatSocialResult({ results: rows }, { platform: 'x', action: 'search_posts', query: 'anima', language: 'ja' });
  assert.match(filtered, /language="ja" で 2 件中 1 件に絞り込み/);
  assert.match(filtered, /日本語の投稿/);
  assert.equal(filtered.includes('italian anima'), false);
  // 一致 0 件なら元の行を残す（取りこぼし防止）
  const none = formatSocialResult({ results: rows }, { platform: 'x', action: 'search_posts', query: 'anima', language: 'de' });
  assert.equal(none.includes('italian anima'), true);
});

test('execute: raw=true なら整形せず生 JSON を返す', async () => {
  const tools = collect({
    runResult: {
      code: 0,
      stdout: JSON.stringify({ status: 'ok', message: 'success', data: { results: [{ id: '1', text: 'hello' }] } }),
      stderr: '',
      ok: true,
    },
  });
  const text = await tools[0].execute({ query: 'Genspark', raw: true }, EXEC);
  assert.match(text, /"results"/);
  assert.equal(/X（Twitter）の投稿検索/.test(text), false);
});

// ── 振り分けコマンド（/genspark-social など） ────────────────────────────────

/** コマンド一式を組み立てる（runner は呼ばれたら記録）。 */
function buildCommands({ config = {}, calls = [] } = {}) {
  return buildGensparkCommands({
    getConfig: () => ({
      timeoutMs: 600000,
      maxOutputChars: 100000,
      promotedCategories: ['social'],
      commandFollowup: true,
      ...config,
    }),
    runner: {
      async runTool(toolName, toolArgs, options) {
        calls.push({ toolName, toolArgs, options });
        return { code: 0, stdout: JSON.stringify({ status: 'ok', message: '', data: {} }), stderr: '', ok: true };
      },
      resolveEntry: () => 'C:\\fake\\index.js',
      resolveRuntime: () => null,
    },
    catalog: { async load() { return { tools: [] }; }, peek: () => null },
    log: () => {},
  });
}

test('social カテゴリで /genspark-social と各サービス別コマンドを登録する', () => {
  const commands = buildCommands();
  const names = commands.map((command) => command.name);
  assert.deepEqual(names, ['genspark', 'genspark-tools', 'genspark-models', 'genspark-run', 'genspark-social', 'genspark-x', 'genspark-instagram', 'genspark-reddit']);
  // social を無効にすれば消える
  const off = buildCommands({ config: { promotedCategories: ['search'] } });
  assert.equal(off.some((command) => command.name === 'genspark-social'), false);
});

test('/genspark-social は API を呼ばず、AI への振り分け依頼を 1 通だけ送る', async () => {
  const calls = [];
  const commands = buildCommands({ calls });
  const command = commands.find((item) => item.name === 'genspark-social');
  const seen = [];
  const result = await command.handler({ rawInput: '@elonmusk の最近の投稿', commandId: 'c1', attachments: [], agent: followupAgent(seen) });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /X（Twitter）・Instagram・Reddit を AI が選んで検索します:「@elonmusk の最近の投稿」/);
  // コマンド自身は CLI を起動しない（クレジットを消費しない）
  assert.equal(calls.length, 0);
  await tick();
  assert.equal(seen.length, 1);
  const prompt = seen[0].content[0].text;
  assert.match(prompt, /\/genspark-social で次の依頼をしました:「@elonmusk の最近の投稿」/);
  assert.match(prompt, /genspark_x_search/);
  assert.match(prompt, /genspark_instagram_search/);
  assert.match(prompt, /genspark_reddit_search/);
  assert.match(prompt, /limit の既定は 25 件/);
  // 実地メモの改善案（検索作法）がプロンプトに入っている
  assert.match(prompt, /検索語は 1〜2 語に絞る/);
  assert.match(prompt, /language="ja"/);
  assert.match(prompt, /同じサービス内で検索語を変えた再試行は 3 回まで/);
  assert.match(prompt, /コメント取得.*空が多い/);
  assert.equal(seen[0].role, 'user');
  assert.equal(seen[0].source.kind, 'plugin:dsh-genspark');
});

test('/genspark-x は X だけを対象にした依頼を送る', async () => {
  const commands = buildCommands();
  const command = commands.find((item) => item.name === 'genspark-x');
  const seen = [];
  await command.handler({ rawInput: 'DeepSeek Harness', commandId: 'c1', attachments: [], agent: followupAgent(seen) });
  await tick();
  const prompt = seen[0].content[0].text;
  assert.match(prompt, /X（Twitter） を検索してください/);
  assert.match(prompt, /genspark_x_search/);
  assert.equal(prompt.includes('genspark_reddit_search'), false);
});

test('/genspark-social は空入力なら使い方を返し、followup を送らない', async () => {
  const commands = buildCommands();
  const command = commands.find((item) => item.name === 'genspark-social');
  const seen = [];
  const result = await command.handler({ rawInput: '   ', commandId: 'c1', attachments: [], agent: followupAgent(seen) });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /調べたいことを入力してください/);
  await tick();
  assert.equal(seen.length, 0);
});

test('/genspark-social は commandFollowup=false なら明確なエラーを返す', async () => {
  const commands = buildCommands({ config: { commandFollowup: false } });
  const command = commands.find((item) => item.name === 'genspark-social');
  const result = await command.handler({ rawInput: 'Genspark', commandId: 'c1', attachments: [], agent: followupAgent([]) });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /commandFollowup=false/);
});

test('/genspark-social は followup が無い環境ではエラーを返す', async () => {
  const commands = buildCommands();
  const command = commands.find((item) => item.name === 'genspark-social');
  const result = await command.handler({ rawInput: 'Genspark', commandId: 'c1', attachments: [], agent: { session: { header: { cwd: process.cwd() } } } });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /agent\.followup/);
});
