/**
 * Unit tests for social media (lib/social.js, the promoted tools in the social category, and the routing commands).
 * No host and no network required. Run: node tests/social.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { describeToolFull, toolInvocation, invocationLabel } from '../lib/catalog.js';
import { buildGensparkCommands } from '../lib/commands.js';
import { PROMOTED_TOOLS, buildPromotedTools, promotedSummary, socialRetryArgs } from '../lib/promoted.js';
import { autoAction, formatSocialResult, normalizeSocialArgs, postUrlOf, socialFailure } from '../lib/social.js';

const EXEC = { agent: { session: { header: { cwd: process.cwd() } } } };

/** Fake agent that receives followups (the existing conversation, i.e. the receipt, is not sent). */
const followupAgent = (seen) => ({
  session: { header: { cwd: process.cwd() }, snapshotEvents: () => [{ type: 'turn/start' }] },
  followup(message) {
    seen.push(message);
  },
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Collect the promoted tools (the runner only records; runResults are returned in order for retry tests). */
function collect({ categories = ['social'], runResult, runResults, calls = [] } = {}) {
  let index = 0;
  return buildPromotedTools({
    defineTool: (spec) => spec,
    getConfig: () => ({
      timeoutMs: 600000,
      maxOutputChars: 100000,
      promotedCategories: categories,
      // Set the retry delay to 0 to keep the tests fast
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

// ── Resolving canonical CLI command names ────────────────────────────────────

test('toolInvocation: resolves grouped / path / bare tool names to the canonical CLI form', () => {
  // Grouped (social_twitter → gsk social twitter)
  assert.deepEqual(toolInvocation({ name: 'social_twitter', cli: { group: 'social' } }), ['social', 'twitter']);
  assert.deepEqual(toolInvocation({ name: 'x_search_tweets', cli: { group: 'x' } }), ['x', 'search_tweets']);
  assert.deepEqual(toolInvocation({ name: 'notion_mcp_tools', cli: { group: 'notion_mcp' } }), ['notion_mcp', 'tools']);
  assert.deepEqual(
    toolInvocation({ name: 'social_reddit', cli: { group: 'social', subcommand: 'reddit' } }),
    ['social', 'reddit'],
  );
  // With a path (task create / telephony call dial)
  assert.deepEqual(toolInvocation({ name: 'create_task', cli: { path: ['task', 'create'], group: 'task' } }), ['task', 'create']);
  assert.deepEqual(
    toolInvocation({ name: 'phone_call', cli: { path: ['telephony', 'call', 'dial'] } }),
    ['telephony', 'call', 'dial'],
  );
  // Bare tool name
  assert.deepEqual(toolInvocation({ name: 'web_search', cli: {} }), ['web_search']);
  assert.deepEqual(toolInvocation({ name: 'me', cli: { group: null } }), ['me']);
});

test('invocationLabel: returns a human-readable command notation', () => {
  assert.equal(invocationLabel({ name: 'social_twitter', cli: { group: 'social' } }), 'gsk social twitter');
  assert.equal(invocationLabel({ name: 'web_search', cli: {} }), 'gsk web_search');
});

test('describeToolFull: also prints the execution command (no confusion even with grouped commands)', () => {
  const text = describeToolFull({
    name: 'social_twitter',
    description: 'Search X',
    cli: { group: 'social' },
    parameters: { properties: { action: { type: 'string' } }, required: ['action'] },
  });
  assert.match(text, /- Run: gsk social twitter/);
});

// ── Automatic action detection and argument normalization ────────────────────

test('autoAction: @handle means posts by that user, while a topic falls back to post search', () => {
  // get_user returns only id / name, so auto does not choose it (measured)
  assert.equal(autoAction('x', '@elonmusk'), 'get_posts_by_author');
  assert.equal(autoAction('instagram', '@natgeo'), 'get_posts_by_user');
  assert.equal(autoAction('reddit', '@foo'), 'get_user');
  assert.equal(autoAction('x', 'from:elonmusk'), 'get_posts_by_author');
  assert.equal(autoAction('x', 'Genspark'), 'search_posts');
  assert.equal(autoAction('reddit', 'local llm'), 'search_posts');
  assert.equal(autoAction('x', ''), 'search_posts');
});

test('normalizeSocialArgs: strips @, fills in defaults, and drops CLI-only keys', () => {
  assert.deepEqual(normalizeSocialArgs('x', 'get_user', { action: 'get_user', query: '@elonmusk', raw: true }), {
    action: 'get_user',
    query: 'elonmusk',
  });
  assert.equal(normalizeSocialArgs('x', 'get_user_connections', { query: 'elonmusk' }).connection_type, 'followers');
  assert.equal(normalizeSocialArgs('x', 'get_post_interacting_users', { post_id: '1' }).interaction_type, 'retweeters');
  assert.equal(normalizeSocialArgs('instagram', 'get_post_interacting_users', { post_id: '1' }).interaction_type, 'likers');
  assert.equal(normalizeSocialArgs('x', 'search_posts', { query: 'x' }).extra, undefined);
});

// ── Formatting ───────────────────────────────────────────────────────────────

const X_DATA = {
  results: [
    { id: '111', text: 'Genspark video generation', author_username: 'alice', impression_count: 1200, created_at_date: '2026-10-15T00:00:00.000Z' },
    { id: '222', text: 'line1\\nline2', author_username: 'bob', impression_count: 5, created_at_date: '2026-10-14T00:00:00.000Z' },
  ],
  pagination: { page: 1, total_rows: 0 },
};

test('formatSocialResult: formats X posts with the count, author, impression count, and URL', () => {
  const text = formatSocialResult(X_DATA, { platform: 'x', action: 'search_posts', query: 'Genspark' });
  assert.match(text, /X \(Twitter\) post search: "Genspark" — 2 results/);
  assert.match(text, /1\. @alice · 2026-10-15 · 1,200 impressions/);
  assert.match(text, /https:\/\/x\.com\/alice\/status\/111/);
  // A literal `\n` (backslash + n) in the raw data is also collapsed to one line
  assert.match(text, /line1 \/ line2/);
  assert.equal(text.includes('\\n'), false);
});

test('formatSocialResult: cuts at limit and distinguishes items returned by the server from items shown', () => {
  const text = formatSocialResult(X_DATA, { platform: 'x', action: 'search_posts', query: 'q', limit: 1 });
  assert.match(text, /… showing 1 of 2 items returned by the server \(1 remaining\)\. Increase with limit \/ use raw: true for all raw data/);
  assert.equal(text.includes('@bob'), false);
});

test('formatSocialResult: Instagram prints the media type, reaction counts, and code_url', () => {
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
  assert.match(text, /Instagram post search/);
  assert.match(text, /@startup \(Startup Grind\)/);
  assert.match(text, /♥ 27 💬 4 ▶ 1,366/);
  assert.match(text, /https:\/\/instagram\.com\/p\/Db3YsDCqDsC/);
});

test('formatSocialResult: Reddit builds the subreddit, author, and URL', () => {
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

test('formatSocialResult: user rows and profiles are printed in @handle form', () => {
  const users = formatSocialResult(
    { results: [{ id: '496236543', username: 'edwardfelix05', name: 'Gen Spark Uyi' }] },
    { platform: 'x', action: 'search_users', query: 'genspark' },
  );
  assert.match(users, /@edwardfelix05 \(Gen Spark Uyi\) · id 496236543/);

  const profile = formatSocialResult(
    { result: { id: '44196397', username: 'elonmusk', name: 'Elon Musk', status: 'success' } },
    { platform: 'x', action: 'get_user', query: 'elonmusk' },
  );
  assert.match(profile, /X \(Twitter\) account info/);
  assert.match(profile, /@elonmusk \(Elon Musk\)/);
});

test('formatSocialResult: an empty result returns the canned text instead of raw JSON', () => {
  const text = formatSocialResult(
    { results: [], pagination: { page: 1, total_pages: 0, total_rows: 0 } },
    { platform: 'reddit', action: 'search_posts', query: 'zzz' },
  );
  assert.match(text, /Reddit post search: "zzz" — no matching results \(the server returned 0 items\)\./);
  assert.equal(text.includes('"results"'), false);
  assert.equal(text.includes('pagination'), false);
});

test('formatSocialResult: sorts posts newest first (because the returned order is not chronological)', () => {
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

test('formatSocialResult: formats Reddit {result:{post,comments}} into title, URL, and comments', () => {
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
  assert.match(text, /Reddit post and comments: "RAMDeck: pool RAM across old PCs"/);
  assert.match(text, /https:\/\/www\.reddit\.com\/r\/kickstarter\/comments\/1x7rkcr/);
  assert.match(text, /Comments: 1 item/);
  assert.match(text, /u\/someone · 2026-10-16 \(\+12\) — Looks promising/);
});

test('formatSocialResult: formats Reddit {result:{subreddit,posts}} into a subreddit heading plus posts', () => {
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
  assert.match(text, /Reddit subreddit: r\/LocalLLaMA \(851,787 subscribers\)/);
  assert.match(text, /Posts: 2 items \(newest first\)/);
  const order = [...text.matchAll(/\/comments\/(p\d)/g)].map((match) => match[1]);
  assert.deepEqual(order, ['p2', 'p1']);
});

test('formatSocialResult: explains a server-side failure', () => {
  const text = formatSocialResult({ result: 'Failed to execute Twitter action' }, { platform: 'x', action: 'count_posts' });
  assert.match(text, /could not run this action/);
  assert.match(text, /changing the action to search_posts \/ search_users \/ get_user/);
  assert.equal(socialFailure({ result: 'Failed to execute Reddit action' }) !== undefined, true);
  assert.equal(socialFailure({ results: [] }), undefined);
});

test('postUrlOf: reconstructs the URL from the id for rows without one', () => {
  assert.equal(postUrlOf('x', { id: '1', author_username: 'a' }), 'https://x.com/a/status/1');
  assert.equal(postUrlOf('reddit', { id: 'p1', subreddit_name: 'rust' }), 'https://www.reddit.com/r/rust/comments/p1');
  assert.equal(postUrlOf('x', { id: '1' }), undefined);
  assert.equal(postUrlOf('instagram', { id: '1' }), undefined);
});

// ── Promoted tools (social category) ─────────────────────────────────────────

test('the social category registers 3 tools', () => {
  const tools = collect();
  assert.deepEqual(tools.map((tool) => tool.name), [
    'genspark_x_search',
    'genspark_instagram_search',
    'genspark_reddit_search',
  ]);
  assert.match(promotedSummary(['search', 'media', 'social']), /social=Social media 3 tools/);
});

test('build: auto-detects the action when omitted, and limit defaults to 25', () => {
  const spec = PROMOTED_TOOLS.find((tool) => tool.name === 'genspark_x_search');
  const built = spec.build({ query: 'Genspark' }, process.cwd());
  assert.equal(built.args.action, 'search_posts');
  assert.equal(built.args.query, 'Genspark');
  assert.equal(built.args.limit, 25);
  assert.deepEqual(built.command, ['social', 'twitter']);
  assert.equal(built.render.limit, 25);
  assert.equal(built.render.raw, false);
});

test('build: @handle means posts by that user; get_user only when specified explicitly', () => {
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

test('build: missing or invalid arguments throw (and the CLI is not started)', () => {
  const x = PROMOTED_TOOLS.find((tool) => tool.name === 'genspark_x_search');
  assert.throws(() => x.build({ action: 'get_comments' }, process.cwd()), /requires post_id \(or post_ids\)/);
  assert.throws(() => x.build({ action: 'nope', query: 'x' }, process.cwd()), /action must be one of .*/);
  assert.throws(() => x.build({ action: 'search_posts' }, process.cwd()), /requires query/);
  const reddit = PROMOTED_TOOLS.find((tool) => tool.name === 'genspark_reddit_search');
  assert.throws(() => reddit.build({ action: 'get_post_with_comments' }, process.cwd()), /requires post_id/);
  const instagram = PROMOTED_TOOLS.find((tool) => tool.name === 'genspark_instagram_search');
  assert.throws(() => instagram.build({ action: 'get_posts_by_ids' }, process.cwd()), /post_id/);
});

test('build: Reddit passes sort / time / subreddit', () => {
  const spec = PROMOTED_TOOLS.find((tool) => tool.name === 'genspark_reddit_search');
  const built = spec.build({ query: 'local llm', sort: 'top', time: 'week', subreddit: 'LocalLLaMA' }, process.cwd());
  assert.equal(built.args.sort, 'top');
  assert.equal(built.args.time, 'week');
  assert.equal(built.args.subreddit, 'LocalLLaMA');
  assert.deepEqual(built.command, ['social', 'reddit']);
});

test('build: dates are sent only to search_posts (dropped for unsupported actions, avoiding the measured failure)', () => {
  const spec = PROMOTED_TOOLS.find((tool) => tool.name === 'genspark_x_search');
  const search = spec.build({ query: 'anima', start_date: '2026-10-11', end_date: '2026-10-18' }, process.cwd());
  assert.equal(search.args.start_date, '2026-10-11');
  assert.equal(search.args.end_date, '2026-10-18');
  // @handle falls back to get_posts_by_author (which does not support dates), so start_date is dropped
  const author = spec.build({ query: '@foo', start_date: '2026-10-11' }, process.cwd());
  assert.equal(author.args.action, 'get_posts_by_author');
  assert.equal(author.args.start_date, undefined);
});

test('socialRetryArgs: returns arguments for one retry only on failure (unsupported actions are not retried)', () => {
  const failed = { result: 'Failed to execute Twitter action' };
  const next = socialRetryArgs({ action: 'search_posts', start_date: 'x', end_date: 'y' }, failed);
  assert.equal(next.action, 'search_posts');
  assert.equal(next.start_date, undefined);
  assert.equal(socialRetryArgs({ action: 'search_posts' }, { results: [] }), null);
  assert.equal(socialRetryArgs({ action: 'count_posts' }, failed), null);
  assert.equal(socialRetryArgs({ action: 'search_subreddits' }, failed), null);
});

test('execute: a transient failure is retried automatically exactly once', async () => {
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
  assert.equal(/could not run this action/.test(text), false);
});

test('execute: if the retry also fails, returns the explanation (stops after 2 calls)', async () => {
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
  assert.match(text, /could not run this action/);
  assert.match(text, /already retried once automatically/);
});

test('execute: passes the grouped command and returns the formatted response', async () => {
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
  assert.match(text, /X \(Twitter\) post search/);
  assert.match(text, /https:\/\/x\.com\/alice\/status\/1/);
});

test('formatSocialResult: with language specified, narrows to rows whose lang matches (does not narrow when 0 match)', () => {
  const rows = [
    { id: '1', text: '\u65e5\u672c\u8a9e\u306e\u6295\u7a3f', author_username: 'a', lang: 'ja', created_at_date: '2026-10-18' },
    { id: '2', text: 'italian anima', author_username: 'b', lang: 'it', created_at_date: '2026-10-17' },
    { id: '3', text: 'no lang field', author_username: 'c', created_at_date: '2026-10-16' },
  ];
  const filtered = formatSocialResult({ results: rows }, { platform: 'x', action: 'search_posts', query: 'anima', language: 'ja' });
  assert.match(filtered, /narrowed to 1 of 2 items with language="ja"/);
  assert.match(filtered, /\u65e5\u672c\u8a9e\u306e\u6295\u7a3f/);
  assert.equal(filtered.includes('italian anima'), false);
  // When 0 rows match, the original rows are kept (to avoid dropping results)
  const none = formatSocialResult({ results: rows }, { platform: 'x', action: 'search_posts', query: 'anima', language: 'de' });
  assert.equal(none.includes('italian anima'), true);
});

test('execute: raw=true returns raw JSON without formatting', async () => {
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
  assert.equal(/X \(Twitter\) post search/.test(text), false);
});

// ── Routing commands (/genspark-social and others) ───────────────────────────

/** Build the full command set (the runner records calls). */
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

test('registers /genspark-social and the per-service commands in the social category', () => {
  const commands = buildCommands();
  const names = commands.map((command) => command.name);
  assert.deepEqual(names, ['genspark', 'genspark-tools', 'genspark-models', 'genspark-run', 'genspark-social', 'genspark-x', 'genspark-instagram', 'genspark-reddit']);
  // They disappear when social is disabled
  const off = buildCommands({ config: { promotedCategories: ['search'] } });
  assert.equal(off.some((command) => command.name === 'genspark-social'), false);
});

test('/genspark-social calls no API and sends exactly one routing request to the AI', async () => {
  const calls = [];
  const commands = buildCommands({ calls });
  const command = commands.find((item) => item.name === 'genspark-social');
  const seen = [];
  const result = await command.handler({ rawInput: '@elonmusk recent posts', commandId: 'c1', attachments: [], agent: followupAgent(seen) });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /The AI will pick from X \(Twitter\) \/ Instagram \/ Reddit and search: "@elonmusk recent posts"/);
  // The command itself starts no CLI (so it spends no credits)
  assert.equal(calls.length, 0);
  await tick();
  assert.equal(seen.length, 1);
  const prompt = seen[0].content[0].text;
  assert.match(prompt, /The user ran \/genspark-social with this request: "@elonmusk recent posts"/);
  assert.match(prompt, /genspark_x_search/);
  assert.match(prompt, /genspark_instagram_search/);
  assert.match(prompt, /genspark_reddit_search/);
  assert.match(prompt, /limit defaults to 25 items/);
  // Improvements from field notes (search practices) are included in the prompt
  assert.match(prompt, /Narrow the query to 1–2 words/);
  assert.match(prompt, /language="ja"/);
  assert.match(prompt, /retry up to 3 times within the same service with a different query/);
  assert.match(prompt, /Comment fetching.*often empty/);
  assert.equal(seen[0].role, 'user');
  assert.equal(seen[0].source.kind, 'plugin:dsh-genspark');
});

test('/genspark-x sends a request that targets X only', async () => {
  const commands = buildCommands();
  const command = commands.find((item) => item.name === 'genspark-x');
  const seen = [];
  await command.handler({ rawInput: 'DeepSeek Harness', commandId: 'c1', attachments: [], agent: followupAgent(seen) });
  await tick();
  const prompt = seen[0].content[0].text;
  assert.match(prompt, /Search X \(Twitter\)\./);
  assert.match(prompt, /genspark_x_search/);
  assert.equal(prompt.includes('genspark_reddit_search'), false);
});

test('/genspark-social returns usage on empty input and sends no followup', async () => {
  const commands = buildCommands();
  const command = commands.find((item) => item.name === 'genspark-social');
  const seen = [];
  const result = await command.handler({ rawInput: '   ', commandId: 'c1', attachments: [], agent: followupAgent(seen) });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /Enter what you want to look up/);
  await tick();
  assert.equal(seen.length, 0);
});

test('/genspark-social returns a clear error when commandFollowup=false', async () => {
  const commands = buildCommands({ config: { commandFollowup: false } });
  const command = commands.find((item) => item.name === 'genspark-social');
  const result = await command.handler({ rawInput: 'Genspark', commandId: 'c1', attachments: [], agent: followupAgent([]) });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /commandFollowup=false/);
});

test('/genspark-social returns an error when followup is unavailable', async () => {
  const commands = buildCommands();
  const command = commands.find((item) => item.name === 'genspark-social');
  const result = await command.handler({ rawInput: 'Genspark', commandId: 'c1', attachments: [], agent: { session: { header: { cwd: process.cwd() } } } });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /agent\.followup/);
});
