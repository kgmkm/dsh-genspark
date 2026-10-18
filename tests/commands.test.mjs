/**
 * Unit tests for the host commands (lib/commands.js). No host and no network required.
 * Run: node tests/commands.test.mjs
 *
 * The `@deepseek-ai/dsh-commands` contract (confirmed against the implementation inside the asar):
 *   - name matches /^[a-z][a-z0-9_-]*$/
 *   - description is a non-empty string
 *   - when input is present it is { hint: non-empty string }
 *   - handler returns { kind: 'success' | 'error', text }
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { autoSavePath, buildGensparkCommands, humanizeData } from '../lib/commands.js';

/** Existing host command names (registering one of them throws at registration time). */
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

/** Build a set of commands for tests. */
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

/** Invocation with attachments (the agent has an attachments service). */
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

/** One image attachment block (the shape the host passes). */
const imageBlock = (id = 'sha256:img1', name = 'test_cat.jpg') => ({
  type: 'image',
  attachment: { attachmentId: id, mediaType: 'image/jpeg', name },
});

/** One file attachment block (the shape the host passes). */
const fileBlock = (id = 'sha256:doc1', name = 'doc.pdf') => ({
  type: 'file',
  attachment: { attachmentId: id, mediaType: 'application/pdf', name },
});

/** Pseudo-agent that receives follow-ups (pushes every message into seen). */
const followupAgent = (seen, cwd = process.cwd()) => ({
  session: { header: { cwd } },
  followup(message) {
    seen.push(message);
  },
});

/**
 * Agent that mimics a new conversation (the log has no turn/start).
 * The session only has `snapshotEvents`, which is used to detect the hero screen.
 */
const freshAgent = (seen, events = [{ type: 'session' }, { type: 'command/run' }]) => ({
  session: { header: { cwd: process.cwd() }, snapshotEvents: () => events },
  followup(message) {
    seen.push(message);
  },
});

/**
 * Follow-ups are deferred to the next tick so command completion is not blocked;
 * advance one tick before asserting (a design choice that avoids the "command never completes" state seen on real hardware).
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const okData = (text) => ({ code: 0, stdout: JSON.stringify(OK_ENVELOPE(text)), stderr: '', ok: true });

// -- Registered commands ------------------------------------------------------

test('returns 14 commands by default: 4 generic + 6 search & research + 4 generated media', () => {
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

test('narrowing categories leaves only the matching commands (the 4 generic commands are always present)', () => {
  assert.equal(harness({ categories: ['search'] }).commands.length, 10);
  assert.equal(harness({ categories: ['media'] }).commands.length, 8);
  assert.equal(harness({ categories: [] }).commands.length, 4);
  const { byName } = harness({ categories: ['search'] });
  assert.equal(byName.has('genspark-image'), false);
  assert.equal(byName.has('genspark-search'), true);
});

test('ignores unknown categories and logs them', () => {
  const logs = [];
  const commands = buildGensparkCommands({
    getConfig: () => ({ promotedCategories: ['search', 'nope'] }),
    runner: { runTool: async () => okData({}) },
    catalog: { load: async () => ({ tools: [] }) },
    log: (message) => logs.push(message),
  });
  assert.equal(commands.length, 10);
  assert.match(logs.join('\n'), /ignoring unknown category "nope"/);
});

test('command metadata satisfies the dsh-commands contract', () => {
  const { commands } = harness({});
  for (const command of commands) {
    assert.match(command.name, /^[a-z][a-z0-9_-]*$/, command.name);
    assert.equal(HOST_COMMANDS.includes(command.name), false, `${command.name} collides with an existing host command`);
    assert.equal(typeof command.description, 'string');
    assert.ok(command.description.trim().length > 0, `${command.name} has an empty description`);
    assert.equal(typeof command.handler, 'function');
    if (command.input !== undefined) {
      assert.equal(typeof command.input.hint, 'string');
      assert.ok(command.input.hint.trim().length > 0, `${command.name} has an empty hint`);
    }
  }
  // Only /genspark (status display) takes no arguments
  const withInput = commands.filter((command) => command.input !== undefined).map((command) => command.name);
  assert.equal(withInput.includes('genspark'), false);
  assert.equal(withInput.length, 13);
});

test('only commands that accept attachments declare input.attachments=true', () => {
  const { byName } = harness({});
  const accepting = ['genspark-analyze-media', 'genspark-summarize', 'genspark-crawl', 'genspark-image', 'genspark-video'];
  for (const name of accepting) {
    assert.equal(byName.get(name).input?.attachments, true, `${name} does not accept attachments`);
  }
  for (const command of harness({}).commands) {
    if (accepting.includes(command.name)) continue;
    assert.notEqual(command.input?.attachments, true, `${command.name} should not accept attachments`);
  }
});

// -- Commands derived from promoted tools ------------------------------------

test('genspark-search runs web_search through --args-file', async () => {
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-search').handler(inv('DeepSeek Harness'));
  assert.equal(result.kind, 'success');
  assert.equal(calls[0].toolName, 'web_search');
  assert.deepEqual(calls[0].toolArgs, { q: 'DeepSeek Harness' });
  assert.deepEqual(calls[0].options.globalArgs, ['--output', 'json', '--timeout', '600000', '--no-input']);
  assert.equal(calls[0].options.cwd, process.cwd());
  assert.match(result.text, /\(tool: web_search\)/);
});

test('returns an error without running when the input is empty', async () => {
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-search').handler(inv('   '));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /Input is required\. Usage: \/genspark-search/);
  assert.equal(calls.length, 0);
});

test('genspark-crawl rejects non-URL input (a natural-language question) before running', async () => {
  // Regression guard for a real incident: passing a question to /genspark-crawl made it fail with
  // "Genspark API error: No content found or crawler failed for ...".
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-crawl').handler(inv('\u3053\u308c\u306f\u30c6\u30b9\u30c8\u3067\u3059\u3002\u6628\u65e5\u65e5\u672c\u3067\u3042\u3063\u305f\u60c5\u5831\u6d41\u51fa\u4e8b\u4ef6\u3092\u6559\u3048\u3066\u304f\u3060\u3055\u3044'));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /must be an http\(s\) URL or the path of an existing local file/);
  assert.match(result.text, /\/genspark-search/);
  assert.equal(calls.length, 0);
});

test('search results are formatted as a list (raw JSON is not printed)', async () => {
  const { byName } = harness({
    runResult: okData({
      organic_results: [
        { title: 'Introducing DeepSeek Harness', url: 'https://example.com/a', snippet: 'How to build a plugin' },
        { title: 'Second item', url: 'https://example.com/b' },
      ],
      related_searches: ['dsh plugin', 'cordis'],
    }),
  });
  const result = await byName.get('genspark-search').handler(inv('dsh'));
  assert.equal(result.kind, 'success');
  assert.match(result.text, /organic_results: 2 items \(showing the first 2\)/);
  assert.match(result.text, /1\. Introducing DeepSeek Harness\n   https:\/\/example\.com\/a\n   How to build a plugin/);
  assert.match(result.text, /related_searches: dsh plugin \/ cordis/);
  assert.equal(result.text.includes('"title"'), false);
});

test('genspark-image saves under genspark-out and reports the saved file', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-genspark-cmd-'));
  const { byName, calls } = harness({
    onRun: async ({ options }) => {
      // Create the artifact instead of the CLI's -o flag
      const path = options.toolArgs[options.toolArgs.indexOf('-o') + 1];
      writeFileSync(path, '12345');
      return okData({ images: [{ url: 'https://example.com/i.png' }] });
    },
  });
  const result = await byName.get('genspark-image').handler(inv('a red cube', cwd));
  assert.equal(result.kind, 'success');
  // save_to is not a Genspark argument; it becomes the CLI's -o option
  assert.deepEqual(calls[0].toolArgs, { query: 'a red cube' });
  const out = calls[0].options.toolArgs;
  assert.equal(out[0], '-o');
  const savedPath = out[1];
  assert.ok(savedPath.startsWith(join(cwd, 'genspark-out')), savedPath);
  assert.match(savedPath, /\.png$/);
  assert.match(result.text, /Saved file: .*\(5 bytes\)/);
});

test('genspark-video uses the default model and a 30-minute timeout floor', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-genspark-cmd-'));
  const { byName, calls } = harness({});
  await byName.get('genspark-video').handler(inv('a drone shot', cwd));
  assert.equal(calls[0].toolName, 'video_generation');
  assert.equal(calls[0].toolArgs.model, 'kling/v3');
  assert.equal(calls[0].options.timeoutMs, 1800000);
  assert.deepEqual(calls[0].options.globalArgs, ['--output', 'json', '--timeout', '1800000', '--no-input']);
});

// -- Meta-intent guard (typing a model list / usage into a generation command spends no credits) --

const withModelTools = () => harness({ tools: [...FAKE_TOOLS, ...MODEL_TOOLS] });
const ranTool = (calls) => calls.some((call) => typeof call.toolName === 'string');

test('generation commands return the model list for a model-list request instead of generating', async () => {
  const { byName, calls } = withModelTools();
  const video = await byName.get('genspark-video').handler(inv('\u52d5\u753b\u30e2\u30c7\u30eb\u306e\u30ea\u30b9\u30c8\u304f\u3060\u3055\u3044'));
  assert.equal(ranTool(calls), false, 'a generation tool ran for a model-list request');
  assert.equal(video.kind, 'success');
  assert.match(video.text, /Nothing was generated \(no credits were spent\)\./);
  assert.match(video.text, /kling\/v3/);

  const audio = await byName.get('genspark-audio').handler(inv('\u4f7f\u3048\u308b\u97f3\u58f0\u30e2\u30c7\u30eb\u3092\u6559\u3048\u3066'));
  assert.equal(ranTool(calls), false);
  assert.match(audio.text, /elevenlabs\/v4-tts/);
});

test('generation commands spend no credits for a usage request', async () => {
  const { byName, calls } = withModelTools();
  const result = await byName.get('genspark-image').handler(inv('\u4f7f\u3044\u65b9'));
  assert.equal(ranTool(calls), false, 'a generation tool ran for a usage request');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /\/genspark-image usage/);
  assert.match(result.text, /No credits were spent \(nothing was generated\)\./);
});

test('a normal generation request that mentions "model" is generated without the guard', async () => {
  const { byName, calls } = withModelTools();
  await byName.get('genspark-video').handler(inv('\u30e2\u30c7\u30eb\u306e\u3088\u3046\u306a\u5973\u6027\u304c\u6b69\u304f\u52d5\u753b'));
  assert.equal(calls[0].toolName, 'video_generation');
  assert.equal(calls[0].toolArgs.query, '\u30e2\u30c7\u30eb\u306e\u3088\u3046\u306a\u5973\u6027\u304c\u6b69\u304f\u52d5\u753b');
});

test('with an attachment, even model-list wording generates (the target is clear)', async () => {
  const { byName, calls } = withModelTools();
  const store = { imageHostPath: () => 'C:\\tmp\\ref.png' };
  await byName.get('genspark-video').handler(invAttached('\u30e2\u30c7\u30eb\u306e\u30ea\u30b9\u30c8', [imageBlock('sha256:i3', 'ref.png')], store));
  assert.equal(calls[0].toolName, 'video_generation');
  assert.deepEqual(calls[0].toolArgs.image_urls, ['C:\\tmp\\ref.png']);
});

test('genspark-summarize runs with the default question when only a URL is given', async () => {
  const { byName, calls } = harness({});
  await byName.get('genspark-summarize').handler(inv('https://example.com/doc.pdf'));
  assert.deepEqual(calls[0].toolArgs, {
    url: 'https://example.com/doc.pdf',
    question: 'Summarize the key points of this document concisely.',
  });
  calls.length = 0;
  await byName.get('genspark-summarize').handler(inv('https://example.com/doc.pdf What does it say?'));
  assert.deepEqual(calls[0].toolArgs, { url: 'https://example.com/doc.pdf', question: 'What does it say?' });
});

test('argument conversion for genspark-maps / genspark-analyze-media', async () => {
  const { byName, calls } = harness({});
  await byName.get('genspark-maps').handler(inv('cafes around Tokyo Station'));
  assert.deepEqual(calls[0].toolArgs, { query_type: 'search', engine: 'maps', query: 'cafes around Tokyo Station' });
  await byName.get('genspark-analyze-media').handler(inv('https://example.com/cat.jpg What is this cat doing?'));
  assert.deepEqual(calls[1].toolArgs, { image_urls: ['https://example.com/cat.jpg'], instruction: 'What is this cat doing?' });
  await byName.get('genspark-analyze-media').handler(inv('https://example.com/clip.mp4'));
  assert.deepEqual(calls[2].toolArgs, { media_urls: ['https://example.com/clip.mp4'], requirements: 'Describe the contents of this media in detail.' });
  assert.equal(calls[2].toolName, 'analyze_media');
});

test('API errors are returned as error results', async () => {
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
  assert.match(result.text, /Genspark API error: rate limited/);
});

test('an aborted signal is forwarded to the runner', async () => {
  const controller = new AbortController();
  const { byName, calls } = harness({});
  const invocation = { ...inv('x'), signal: controller.signal };
  await byName.get('genspark-search').handler(invocation);
  assert.equal(calls[0].options.signal, controller.signal);
});

// -- /genspark-tools ---------------------------------------------------------

test('genspark-tools returns the group overview with no arguments', async () => {
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-tools').handler(inv(''));
  assert.equal(result.kind, 'success');
  assert.match(result.text, /Genspark tool catalog: 3 tools in total/);
  assert.match(result.text, /## Counts by group/);
  assert.equal(calls[0].catalog.refresh, false);
});

test('genspark-tools returns the full argument schema when narrowed to one tool', async () => {
  const { byName } = harness({});
  const result = await byName.get('genspark-tools').handler(inv('web_search'));
  assert.equal(result.kind, 'success');
  assert.match(result.text, /## web_search/);
  assert.match(result.text, /- q \(required\): string \u2014 query/);
  assert.match(result.text, /Example: \/genspark-run web_search/);
});

test('genspark-tools prioritizes an exact name match and narrows to one tool', async () => {
  const tools = [
    { name: 'crawler', description: 'Crawl a page', cli: { aliases: ['crawl'] }, parameters: { properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'deep_crawl', description: 'Crawler for whole sites', cli: {}, parameters: { properties: {} } },
  ];
  const { byName } = harness({ tools });
  const result = await byName.get('genspark-tools').handler(inv('crawler'));
  assert.equal(result.kind, 'success');
  assert.match(result.text, /## crawler\b/);
  assert.doesNotMatch(result.text, /Counts by group/);
});

test('genspark-tools --refresh requests a cache refresh', async () => {
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-tools').handler(inv('--refresh crawler'));
  assert.equal(result.kind, 'success');
  assert.equal(calls[0].catalog.refresh, true);
  assert.match(result.text, /## crawler|No matches/);
});

test('returns an error when the catalog cannot be loaded', async () => {
  const { byName } = harness({ catalogError: new Error('Could not retrieve the catalog (exit code: 1)') });
  const result = await byName.get('genspark-tools').handler(inv(''));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /Could not load the catalog/);
});

// -- /genspark-run -----------------------------------------------------------

test('genspark-run runs an arbitrary tool read-only', async () => {
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-run').handler(inv('web_search {"q":"dsh"}'));
  assert.equal(result.kind, 'success');
  assert.equal(calls[1].toolName, 'web_search');
  assert.deepEqual(calls[1].toolArgs, { q: 'dsh' });
  assert.deepEqual(calls[1].options.globalArgs, ['--output', 'json', '--timeout', '600000', '--no-input']);
});

test('genspark-run shows usage when no arguments are given', async () => {
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-run').handler(inv(''));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /Usage: \/genspark-run <tool-name> \[JSON arguments\]/);
  assert.equal(calls.length, 0);
});

test('genspark-run rejects broken JSON before running', async () => {
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-run').handler(inv('web_search {q:dsh}'));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /Could not parse the JSON arguments/);
  assert.equal(calls.length, 0);
});

test('genspark-run rejects a nonexistent tool', async () => {
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-run').handler(inv('nope_tool {}'));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /Genspark has no tool named "nope_tool"/);
  assert.match(result.text, /CLI built-in read-only commands me can be run/);
  assert.equal(calls.filter((call) => call.toolName).length, 0);
});

test('genspark-run can run the read-only built-in command (me) that is not in the catalog', async () => {
  const { byName, calls } = harness({ runResult: okData({ email: 'backorz@gmail.com' }) });
  const result = await byName.get('genspark-run').handler(inv('me'));
  assert.equal(result.kind, 'success');
  assert.equal(calls[1].toolName, 'me');
  assert.deepEqual(calls[1].toolArgs, {});
});

test('genspark-run does not run interactive or confirmation-required operations', async () => {
  const { byName, calls } = harness({});
  const interactive = await byName.get('genspark-run').handler(inv('x_post_tweet {}'));
  assert.equal(interactive.kind, 'error');
  assert.match(interactive.text, /requires interactive input/);

  const gated = await byName.get('genspark-run').handler(inv('slack_send {}'));
  assert.equal(gated.kind, 'error');
  assert.match(gated.text, /requires confirmation/);
  assert.match(gated.text, /genspark_run tool \(approve_write: true\)/);
  assert.equal(calls.filter((call) => call.toolName).length, 0);
});

// -- Attachments (composer images / files) -----------------------------------

test('genspark-analyze-media resolves attached images to host paths and passes them to understand_images', async () => {
  const { byName, calls } = harness({});
  const store = { imageHostPath: () => 'C:\\tmp\\test_cat.jpg' };
  const result = await byName.get('genspark-analyze-media').handler(invAttached('', [imageBlock()], store));
  assert.equal(result.kind, 'success');
  assert.equal(calls[0].toolName, 'understand_images');
  assert.deepEqual(calls[0].toolArgs, {
    image_urls: ['C:\\tmp\\test_cat.jpg'],
    instruction: 'Describe the contents of this media in detail.',
  });
});

test('genspark-analyze-media passes an attachment plus instruction text as the instruction (the input is not interpreted as a media reference)', async () => {
  const { byName, calls } = harness({});
  const store = { imageHostPath: () => 'C:\\tmp\\a.jpg' };
  await byName.get('genspark-analyze-media').handler(invAttached('What is this cat doing?', [imageBlock()], store));
  assert.deepEqual(calls[0].toolArgs, { image_urls: ['C:\\tmp\\a.jpg'], instruction: 'What is this cat doing?' });
});

test('explains the problem without starting the CLI when there is no attachment store', async () => {
  const { byName, calls } = harness({});
  const result = await byName.get('genspark-analyze-media').handler({
    rawInput: '',
    commandId: 'c3',
    attachments: [imageBlock()],
    signal: undefined,
    agent: { session: { header: { cwd: process.cwd() } } },
  });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /this profile has no attachments service/);
  assert.equal(calls.length, 0);
});

test('attachments resolve through the plugin ctx too (for hosts without an agent ctx)', async () => {
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

test('an extension-less host path (real-store image) is copied with an extension', async () => {
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
  assert.notEqual(used, hostPath, 'an extension-less path was passed as-is');
  assert.match(used, /\.jpg$/);
  assert.equal(existsSync(used), true);
  assert.equal(readFileSync(used, 'utf8'), 'normalized-jpeg-bytes');
});

test('an attachment without a host path writes readImage bytes to genspark-out/attachments', async () => {
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
  assert.equal(written.length, 1, 'the attachment bytes were not saved');
  assert.match(written[0], /\.jpg$/);
  assert.equal(calls[0].toolArgs.image_urls[0], join(dir, 'genspark-out', 'attachments', written[0]));
});

test('genspark-image / genspark-video put attachments in image_urls', async () => {
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

test('genspark-summarize / genspark-crawl target attached files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'genspark-attach-doc-'));
  const doc = join(dir, 'report.pdf');
  writeFileSync(doc, 'fake-pdf');
  const store = { fileHostPath: () => doc };
  const { byName, calls } = harness({});
  await byName.get('genspark-summarize').handler(invAttached('What are the key points?', [fileBlock()], store, dir));
  assert.equal(calls[0].toolName, 'summarize_large_document');
  assert.deepEqual(calls[0].toolArgs, { url: doc, question: 'What are the key points?' });

  await byName.get('genspark-crawl').handler(invAttached('', [fileBlock()], store, dir));
  assert.equal(calls[1].toolName, 'crawler');
  assert.deepEqual(calls[1].toolArgs, { url: doc });
});

test('media-analysis results show the analysis body without list formatting', async () => {
  const { byName } = harness({
    runResult: {
      code: 0,
      stdout: JSON.stringify({
        status: 'ok',
        message: 'success',
        data: { results: [{ url: 'https://www.genspark.ai/api/files/s/x', result: 'A brown tabby cat is sitting on the table.', validate: true }] },
      }),
      stderr: '',
      ok: true,
    },
  });
  const store = { imageHostPath: () => 'C:\\tmp\\a.jpg' };
  const result = await byName.get('genspark-analyze-media').handler(invAttached('', [imageBlock()], store));
  assert.equal(result.kind, 'success');
  assert.match(result.text, /A brown tabby cat is sitting on the table\./);
  assert.equal(/"validate"/.test(result.text), false);
});

// -- /genspark (status display) ----------------------------------------------

test('genspark returns connection status, account, tool count, and usage', async () => {
  const { byName, calls } = harness({
    runResult: okData({ email: 'backorz@gmail.com', name: 'mkgm', plan: 'plus', credit_balance: 8521 }),
  });
  const result = await byName.get('genspark').handler(inv(''));
  assert.equal(result.kind, 'success');
  assert.match(result.text, /CLI entry: C:\\fake/);
  assert.match(result.text, /Runtime: C:\\Program Files\\nodejs\\node.exe \(auto\)/);
  assert.match(result.text, /Account: backorz@gmail\.com \(mkgm\) \/ plan plus/);
  assert.match(result.text, /Remaining credits: 8521/);
  assert.match(result.text, /Tools: 3 items/);
  assert.match(result.text, /Promoted tools: search=Search & research 6 tools \/ media=Generated media 4 tools/);
  assert.match(result.text, /Available commands:/);
  assert.match(result.text, /\/genspark-image Description of the image to generate/);
  // Tools with no arguments (me) run without --args-file
  assert.deepEqual(calls[0].toolName, 'me');
  assert.deepEqual(calls[0].toolArgs, {});
});

test('genspark keeps showing status when the account lookup fails', async () => {
  const { byName } = harness({
    runResult: { code: 1, stdout: '', stderr: '[ERROR] not logged in', ok: false },
  });
  const result = await byName.get('genspark').handler(inv(''));
  assert.equal(result.kind, 'success');
  assert.match(result.text, /Account: could not be retrieved/);
  assert.match(result.text, /Tools: 3 items/);
});

// -- Handing command results to the model (agent.followup) -------------------
// Host command results only appear in the command area by default, so the AI cannot interpret them.
// After a run, hand the result to the next turn via agent.followup (the commandFollowup setting).

test('command results are handed to the model through agent.followup', async () => {
  const seen = [];
  const { byName } = harness({});
  const result = await byName
    .get('genspark-search')
    .handler(inv('Tokyo weather', process.cwd(), followupAgent(seen)));
  await tick();

  assert.equal(result.kind, 'success');
  assert.equal(seen.length, 1);
  // Canonical producer kind in session format V4 (`kind: 'plugin'` is deprecated and rejected)
  assert.deepEqual(seen[0].source, { kind: 'plugin:dsh-genspark' });
  const text = seen[0].content[0].text;
  assert.match(text, /Genspark command result for \/genspark-search Tokyo weather\./);
  assert.match(text, /Status: success/);
  // The result body is included as-is (the model can read the same content as the command area)
  assert.match(text, /echo/);
  // Also instruct the model not to repeat the same content
  assert.match(text, /Do not repeat it/);
  assert.match(text, /Answer in the same language the user is using\./);
});

test('error results are handed off too (so the AI can explain the cause)', async () => {
  const seen = [];
  const { byName } = harness({});
  const result = await byName.get('genspark-search').handler(inv('', process.cwd(), followupAgent(seen)));
  await tick();

  assert.equal(result.kind, 'error');
  assert.equal(seen.length, 1);
  const text = seen[0].content[0].text;
  assert.match(text, /Status: error/);
  assert.match(text, /Input is required/);
});

test('commandFollowup: false does not hand results to the model (the result stays in the command area as before)', async () => {
  const seen = [];
  const { byName } = harness({ config: { commandFollowup: false } });
  const result = await byName
    .get('genspark-search')
    .handler(inv('Tokyo weather', process.cwd(), followupAgent(seen)));
  await tick();

  assert.equal(result.kind, 'success');
  assert.equal(seen.length, 0);
});

test('commands do not break on hosts whose agent has no followup', async () => {
  const { byName } = harness({});
  // The default agent for inv is only { session: { header: { cwd } } } (no followup)
  const result = await byName.get('genspark-search').handler(inv('Tokyo weather'));
  assert.equal(result.kind, 'success');
});

test('the command result is still returned and logged when followup fails', async () => {
  const logs = [];
  const { byName } = harness({ log: (message) => logs.push(message) });
  const agent = {
    session: { header: { cwd: process.cwd() } },
    followup() {
      throw new Error('driver gone');
    },
  };
  const result = await byName.get('genspark-search').handler(inv('Tokyo weather', process.cwd(), agent));
  await tick();

  assert.equal(result.kind, 'success');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /failed to hand off the command result \(\/genspark-search\): driver gone/);
});

// On real hardware we observed a state where "the command never completes and neither the result nor the AI reply appears",
// so pin that the command always completes even when the follow-up does not return or is rejected.

test('the command result returns immediately even when followup returns a never-settling Promise', async () => {
  const { byName } = harness({});
  const agent = {
    session: { header: { cwd: process.cwd() } },
    followup() {
      return new Promise(() => {}); // never settles
    },
  };
  const result = await byName.get('genspark-search').handler(inv('Tokyo weather', process.cwd(), agent));
  assert.equal(result.kind, 'success');
});

test('logs a rejected followup Promise and continues', async () => {
  const logs = [];
  const { byName } = harness({ log: (message) => logs.push(message) });
  const agent = {
    session: { header: { cwd: process.cwd() } },
    followup() {
      return Promise.reject(new Error('driver rejected'));
    },
  };
  const result = await byName.get('genspark-search').handler(inv('Tokyo weather', process.cwd(), agent));
  await tick();

  assert.equal(result.kind, 'success');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /failed to hand off the command result \(\/genspark-search\): driver rejected/);
});

// -- Early return for long-running commands (shorten the frozen input field) --
// The host stays in the sending transaction (phase = submitting) until the command completes,
// and the composer is not editable and the draft is retained during that time
// (dsh-client-ui-conversation/lib/client.js:17292 machineBusy and :17295 editable.
// Measured: image generation took 8 seconds and the input field stayed frozen the whole time).
// Once commandInlineWaitMs passes, complete the command and deliver the result to chat via the follow-up.

/** Promise that can be resolved manually (simulates a long-running command). */
function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Wait until the background run after an early return finishes. */
const settleAll = () => new Promise((resolve) => setTimeout(resolve, 20));

test('by default a long-running command is not awaited and the result arrives through the follow-up', async () => {
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
    .handler(inv('Tokyo weather', process.cwd(), followupAgent(seen)));

  assert.equal(result.kind, 'success');
  assert.match(result.text, /The result will arrive in chat afterwards/);
  assert.equal(seen.length, 0); // still running, so no follow-up yet

  gate.resolve();
  await settleAll();
  assert.equal(seen.length, 1);
  const text = seen[0].content[0].text;
  assert.match(text, /Status: success/);
  assert.match(text, /slow/); // the result body arrives in chat
});

test('the follow-up message has the V4 user/message required fields (id / role / source)', async () => {
  // If a message is persisted without `id`, opening the session next time fails with
  // "session event at seq N lacks an identified message" (observed on real hardware).
  const gate = deferred();
  const seen = [];
  const { byName } = harness({
    config: { commandInlineWaitMs: 20 },
    onRun: async () => {
      await gate.promise;
      return okData({ echo: 'slow' });
    },
  });
  await byName.get('genspark-search').handler(inv('Tokyo weather', process.cwd(), followupAgent(seen)));
  gate.resolve();
  await settleAll();

  assert.equal(seen.length, 1);
  const message = seen[0];
  assert.equal(message.role, 'user');
  assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(message.source.kind, 'plugin:dsh-genspark');
  assert.ok(Array.isArray(message.content) && message.content.length > 0);
});

test('the id changes on every follow-up (message identifiers are not shared)', async () => {
  const seen = [];
  const { byName } = harness({ onRun: async () => okData({ echo: 'ok' }) });
  const command = byName.get('genspark-search');
  await command.handler(inv('a', process.cwd(), followupAgent(seen)));
  await command.handler(inv('b', process.cwd(), followupAgent(seen)));
  await settleAll();

  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].id, seen[1].id);
});

test('the receipt message includes the wait estimate for the generation kind', async () => {
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
    .handler(inv('rabbit cafe', process.cwd(), followupAgent(seen)));

  assert.equal(result.kind, 'success');
  assert.match(result.text, /Sending to Genspark \(estimate: 1\u20132 min/);
  assert.match(result.text, /The result will arrive in chat afterwards/);

  gate.resolve();
  await settleAll();
  assert.equal(seen.length, 1);
});

test('generation commands return "Sending to Genspark" right after input by default', async () => {
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
    .handler(inv('rabbit cafe', process.cwd(), followupAgent(seen)));
  const elapsed = Date.now() - started;

  assert.equal(result.kind, 'success');
  assert.match(result.text, /Sending to Genspark \(estimate: 1\u20132 min/);
  assert.match(result.text, /The result will arrive in chat afterwards/);
  assert.ok(elapsed < 1000, `the receipt message is slow: ${elapsed}ms`);
  assert.equal(seen.length, 0); // the result is not here yet

  gate.resolve();
  await settleAll();
  assert.equal(seen.length, 1);
  assert.match(seen[0].content[0].text, /Status: success/);
});

test('the receipt message still returns in 150ms when commandInlineWaitMs is the default 2500', async () => {
  // cordis.patch.yml and the schema default both specify 2500, and honoring that value delays the receipt by 2.5 seconds (the 0.1.7 regression).
  const gate = deferred();
  const seen = [];
  const { byName } = harness({
    config: { commandInlineWaitMs: 2500 },
    onRun: async () => {
      await gate.promise;
      return okData({ url: 'https://example.com/x.mp4' });
    },
  });
  const started = Date.now();
  const result = await byName
    .get('genspark-video')
    .handler(inv('rabbit cafe', process.cwd(), followupAgent(seen)));
  const elapsed = Date.now() - started;

  assert.equal(result.kind, 'success');
  assert.match(result.text, /Sending to Genspark/);
  assert.ok(elapsed < 1000, `the receipt message is slow: ${elapsed}ms`);
  assert.equal(seen.length, 0);

  gate.resolve();
  await settleAll();
  assert.equal(seen.length, 1);
});

test('with commandInlineWaitMs: 0, generation commands also wait for completion without a receipt', async () => {
  const gate = deferred();
  const seen = [];
  const { byName } = harness({
    config: { commandInlineWaitMs: 0 },
    onRun: async () => {
      await gate.promise;
      return okData({ url: 'https://example.com/x.mp4' });
    },
  });
  const pending = byName
    .get('genspark-video')
    .handler(inv('rabbit cafe', process.cwd(), followupAgent(seen)));
  gate.resolve();
  const result = await pending;

  assert.equal(result.kind, 'success');
  assert.doesNotMatch(result.text, /Sending to Genspark/);
  assert.doesNotMatch(result.text, /The result will arrive in chat afterwards/);
});

test('in a new conversation, starting a turn on receipt clears the hero screen', async () => {
  const gate = deferred();
  const seen = [];
  const { byName } = harness({
    onRun: async () => {
      await gate.promise;
      return okData({ url: 'https://example.com/x.mp4' });
    },
  });
  const result = await byName
    .get('genspark-video')
    .handler(inv('rabbit cafe', process.cwd(), freshAgent(seen)));

  assert.match(result.text, /Sending to Genspark/);
  await tick();
  assert.equal(seen.length, 1, 'the receipt turn starts exactly once');
  assert.match(seen[0].content[0].text, /was accepted/);
  assert.match(seen[0].content[0].text, /Sending to Genspark \(estimate: 1\u20132 min/);
  assert.deepEqual(seen[0].source, { kind: 'plugin:dsh-genspark' });

  gate.resolve();
  await settleAll();
  assert.equal(seen.length, 2, 'the result follow-up arrives');
});

test('an existing conversation (with turn/start) does not start a receipt turn', async () => {
  const gate = deferred();
  const seen = [];
  const { byName } = harness({
    onRun: async () => {
      await gate.promise;
      return okData({ url: 'https://example.com/x.mp4' });
    },
  });
  const result = await byName
    .get('genspark-video')
    .handler(inv('rabbit cafe', process.cwd(), freshAgent(seen, [{ type: 'turn/start' }])));

  assert.match(result.text, /Sending to Genspark/);
  await tick();
  assert.equal(seen.length, 0, 'the command area is visible, so no extra turn');

  gate.resolve();
  await settleAll();
  assert.equal(seen.length, 1, 'only the result follow-up arrives');
});

test('a failed generation returns an error with the status and reason', async () => {
  const { byName } = harness({
    onRun: async () =>
      okData({
        generated_videos: [
          { id: '3f036086-ebfc-4173-a7e0-a793649490f4', status: 'FAILED', failure_reason: 'sensitive content detected' },
        ],
      }),
  });
  const result = await byName
    .get('genspark-video')
    .handler(inv('rabbit cafe', process.cwd(), followupAgent([])));

  assert.equal(result.kind, 'error');
  assert.match(result.text, /no file was saved/);
  assert.match(result.text, /status: FAILED/);
  assert.match(result.text, /sensitive content detected/);
  assert.match(result.text, /3f036086-ebfc-4173-a7e0-a793649490f4/);
  assert.match(result.text, /Rejected by the safety policy/);
  assert.match(result.text, /soften the prompt wording/);
});

test('safety-policy rejections include guidance even when the reason is in English', async () => {
  const { byName } = harness({
    onRun: async () =>
      okData({
        generated_videos: [
          {
            task_id: 'dea35fcb-e749-49b9-96a7-036135d08c4f',
            status: 'FAILURE',
            failure_reason:
              "Content was rejected by the platform's safety policy. Please adjust your prompt or input and try again.",
          },
        ],
      }),
  });
  const result = await byName
    .get('genspark-video')
    .handler(inv('cat cafe', process.cwd(), followupAgent([])));

  assert.equal(result.kind, 'error');
  assert.match(result.text, /status: FAILURE/);
  assert.match(result.text, /Rejected by the safety policy/);
  assert.match(result.text, /try a different model/);
  assert.doesNotMatch(result.text, /CLI returned without waiting for the generation to finish/);
});

test('when saving fails, returns the URL and reports success', async () => {
  const { byName } = harness({
    onRun: async () =>
      okData({
        generated_videos: [{ id: 'v1', status: 'SUCCESS', video_urls: ['https://example.com/a.mp4'] }],
      }),
  });
  const result = await byName
    .get('genspark-video')
    .handler(inv('rabbit cafe', process.cwd(), followupAgent([])));

  assert.equal(result.kind, 'success');
  assert.match(result.text, /Could not save the file\. Fetch it from this URL: https:\/\/example\.com\/a\.mp4/);
});

test('a run that fails after an early return is handed off as an error', async () => {
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
    .handler(inv('Tokyo weather', process.cwd(), followupAgent(seen)));
  assert.match(result.text, /The result will arrive in chat afterwards/);

  gate.resolve();
  await settleAll();
  assert.equal(seen.length, 1);
  assert.match(seen[0].content[0].text, /Status: error/);
});

test('with commandInlineWaitMs: 0, waits for completion and returns the result as before', async () => {
  const seen = [];
  const gate = deferred();
  const { byName } = harness({
    config: { commandInlineWaitMs: 0 },
    onRun: async () => {
      await gate.promise;
      return okData({ echo: 'slow' });
    },
  });
  const pending = byName.get('genspark-search').handler(inv('Tokyo weather', process.cwd(), followupAgent(seen)));
  gate.resolve();
  const result = await pending;

  assert.equal(result.kind, 'success');
  assert.match(result.text, /slow/); // the result appears in the command area
  assert.doesNotMatch(result.text, /The result will arrive in chat afterwards/);
  await settleAll();
  assert.equal(seen.length, 1);
});

test('commandFollowup: false does not return early (there is no way to deliver the result)', async () => {
  const seen = [];
  const gate = deferred();
  const { byName } = harness({
    config: { commandFollowup: false, commandInlineWaitMs: 20 },
    onRun: async () => {
      await gate.promise;
      return okData({ echo: 'slow' });
    },
  });
  const pending = byName.get('genspark-search').handler(inv('Tokyo weather', process.cwd(), followupAgent(seen)));
  gate.resolve();
  const result = await pending;

  assert.match(result.text, /slow/);
  assert.equal(seen.length, 0);
});

test('hosts whose agent has no followup do not return early (so the result is not lost)', async () => {
  const gate = deferred();
  const { byName } = harness({
    config: { commandInlineWaitMs: 20 },
    onRun: async () => {
      await gate.promise;
      return okData({ echo: 'slow' });
    },
  });
  const pending = byName.get('genspark-search').handler(inv('Tokyo weather'));
  gate.resolve();
  const result = await pending;

  assert.match(result.text, /slow/);
});

test('after an early return, the caller signal is not forwarded (the background run is not affected)', async () => {
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
  const invocation = { ...inv('Tokyo weather', process.cwd(), followupAgent(seen)), signal: controller.signal };
  const result = await byName.get('genspark-search').handler(invocation);

  assert.match(result.text, /The result will arrive in chat afterwards/);
  assert.ok(captured, 'a signal is passed to the runner');
  assert.notEqual(captured, controller.signal); // a separate forwarding signal
  controller.abort(new Error('rpc settled')); // even if the RPC side aborts after the early return,
  assert.equal(captured.aborted, false); // the background run stays alive

  gate.resolve();
  await settleAll();
  assert.equal(seen.length, 1);
  assert.match(seen[0].content[0].text, /Status: success/);
});

test('an abort while waiting is forwarded (cancellation during the run works)', async () => {
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
  const invocation = { ...inv('Tokyo weather', process.cwd(), followupAgent(seen)), signal: controller.signal };
  const pending = byName.get('genspark-search').handler(invocation);
  await tick();
  controller.abort(new Error('cancel'));
  assert.equal(captured.aborted, true);

  gate.resolve();
  await pending;
});

// -- Helper functions --------------------------------------------------------

test('autoSavePath builds an absolute path under genspark-out (does not break on Japanese input)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-genspark-cmd-'));
  const path = autoSavePath(cwd, 'image', '\u8d64\u3044\u7acb\u65b9\u4f53', 'png');
  assert.ok(path.startsWith(join(cwd, 'genspark-out')));
  assert.match(path, /-image\.png$/);
  mkdirSync(join(cwd, 'genspark-out'), { recursive: true });
});

test('humanizeData returns null when there is no list (falls back to the JSON view)', () => {
  assert.equal(humanizeData({ email: 'a@example.com', plan: 'plus' }), null);
  assert.equal(humanizeData(undefined), null);
  assert.match(humanizeData({ images: [{ url: 'https://example.com/i.png' }] }), /images: 1 items/);
});

test('humanizeData picks the title and arrays from nested entries (model_info)', () => {
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
  assert.match(text, /models: 1 items/);
  // The direct key (model_name) wins; the nested name is used only when there is no direct key
  assert.match(text, /1\. kling\/v3/);
  assert.match(text, /capabilities: text_to_video \/ image_to_video/);
  assert.match(text, /strengths: Latest Kling V3 model/);
});

test('humanizeData prints one-line JSON only when nothing is pickable', () => {
  const text = humanizeData({ results: [{ unknown_field: 42 }] });
  assert.match(text, /results: 1 items/);
  assert.match(text, /\{"unknown_field":42\}/);
});

/** Minimal catalog with model enums. */
const MODEL_TOOLS = [
  { name: 'image_generation', parameters: { properties: { model: { enum: ['nano-banana-2.1', 'gpt-image-2'] } } } },
  { name: 'video_generation', parameters: { properties: { model: { enum: ['kling/v3', 'gemini/veo3.1'] } } } },
  { name: 'audio_generation', parameters: { properties: { model: { enum: ['elevenlabs/v4-tts', 'elevenlabs/music'] } } } },
  { name: 'audio_transcribe', parameters: { properties: { model: { enum: ['whisper-1'] } } } },
];

test('/genspark-models lists the catalog model enums by kind', async () => {
  const { byName } = harness({ tools: MODEL_TOOLS });
  const result = await byName.get('genspark-models').handler(inv(''));
  assert.equal(result.kind, 'success');
  assert.match(result.text, /### Image generation \u2014 2 models \(\/genspark-image \/ genspark_generate_image\)/);
  assert.match(result.text, /nano-banana-2\.1 \/ gpt-image-2/);
  assert.match(result.text, /### Video generation \u2014 2 models/);
  assert.match(result.text, /kling\/v3 \/ gemini\/veo3\.1/);
  assert.match(result.text, /### Transcription \u2014 1 model/);
});

test('/genspark-models filters by Japanese kind names and partial id matches', async () => {
  const { byName } = harness({ tools: MODEL_TOOLS });
  const models = byName.get('genspark-models');

  const video = await models.handler(inv('\u52d5\u753b'));
  assert.match(video.text, /kling\/v3/);
  assert.equal(/nano-banana/.test(video.text), false);

  const kling = await models.handler(inv('kling'));
  assert.match(kling.text, /kling\/v3/);
  assert.equal(/elevenlabs/.test(kling.text), false);

  const missing = await models.handler(inv('nonexistent model'));
  assert.match(missing.text, /No matching models were found/);
});

test('/genspark-models returns an error when the catalog fails to load', async () => {
  const { byName } = harness({ tools: MODEL_TOOLS, catalogError: new Error('boom') });
  const result = await byName.get('genspark-models').handler(inv(''));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /Could not load the model list: boom/);
});
