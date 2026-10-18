/**
 * Unit tests for pure logic (no host or network required).
 * Run: node --test tests/
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import test from 'node:test';

import { createCatalogCache, describeCatalogFull, filterTools, groupOf, groupSummary, summarizeCatalog } from '../lib/catalog.js';
import { detectMetaIntent, isGenerationTool, modelKindOfTool } from '../lib/guard.js';
import { resolveTmpRoot, writeArgsFile } from '../lib/gsk-cli.js';
import { collectModels, formatModelList, kindOfInput } from '../lib/models.js';
import { describeRun, isEnvelope, parseEnvelope, truncate } from '../lib/result.js';
import { buildGensparkTools, resolveWritePolicy, schemaRequiresConfirmation } from '../lib/tools.js';

// -- result.js ----------------------------------------------------------------

test('parseEnvelope: extracts a single envelope line', () => {
  const { value } = parseEnvelope('{"status":"ok","message":"done","data":{"a":1}}\n');
  assert.equal(value.status, 'ok');
  assert.equal(value.data.a, 1);
  assert.equal(isEnvelope(value), true);
});

test('parseEnvelope: picks the JSON line even when progress lines are mixed in', () => {
  const stdout = '[INFO] something\n{"status":"ok","message":"","data":[1,2]}\n';
  const { value } = parseEnvelope(stdout);
  assert.deepEqual(value.data, [1, 2]);
});

test('parseEnvelope: also reads the catalog shape (no envelope)', () => {
  const { value } = parseEnvelope('{"tools":[{"name":"web_search"}],"features":{}}');
  assert.equal(isEnvelope(value), false);
  assert.equal(value.tools.length, 1);
});

test('parseEnvelope: undefined when there is no JSON', () => {
  const { value, raw } = parseEnvelope('not json at all');
  assert.equal(value, undefined);
  assert.match(raw, /not json/);
});

test('describeRun: an ok envelope formats and returns data', () => {
  const result = { code: 0, stdout: '{"status":"ok","message":"","data":{"answer":42}}', stderr: '' };
  const described = describeRun(result, { tool: 'x' });
  assert.equal(described.ok, true);
  assert.match(described.text, /"answer": 42/);
});

test('describeRun: treats it as success when the envelope is ok even if the exit code is abnormal (guards against auto-update pollution)', () => {
  const result = { code: 3221226505, stdout: '{"status":"ok","message":"","data":"1.14.0"}', stderr: 'Assertion failed: ...' };
  assert.equal(describeRun(result, { tool: '--version' }).ok, true);
});

test('describeRun: audio_transcribe outputs segments as the body even when full_text is empty (does not output words)', () => {
  const data = {
    'https://www.genspark.ai/api/files/s/YLfVr5A0': {
      status: 'completed',
      audio_url: 'https://www.genspark.ai/api/files/s/YLfVr5A0',
      language: 'japanese',
      full_text: '',
      segments: '0.00-5.52: Hello from the transcript',
      words: 'w_5d8194af 0.00-0.66: Hel\nw_60036a34 0.66-0.84: lo\nw_7a0c911e 0.84-1.16: fro',
      entities: null,
      analysis_result_url: 'https://www.genspark.ai/api/files/s/sYQFNffF',
      words_url: 'https://www.genspark.ai/api/files/s/PlRrf7Pu',
    },
  };
  const result = { code: 0, stdout: JSON.stringify({ status: 'ok', message: 'success', data }), stderr: '' };
  const described = describeRun(result, { tool: 'audio_transcribe' });
  assert.equal(described.ok, true);
  assert.match(described.text, /Hello from the transcript/);
  assert.match(described.text, /language: japanese/);
  assert.match(described.text, /analysis_result_url: https:\/\/www\.genspark\.ai\/api\/files\/s\/sYQFNffF/);
  assert.equal(/w_5d8194af/.test(described.text), false, 'words (word-level timestamps) are shown');
  assert.equal(/full_text/.test(described.text), false, 'the whole JSON is shown');
});

test('describeRun: prefers full_text over segments and also reads a segments array', () => {
  const withFullText = {
    status: 'completed',
    full_text: 'Full text body',
    segments: '0.00-1.00: partial',
  };
  const first = describeRun({ code: 0, stdout: JSON.stringify({ status: 'ok', data: withFullText }), stderr: '' }, {});
  assert.match(first.text, /Full text body/);
  assert.equal(/partial/.test(first.text), false, 'segments are shown redundantly');

  const withArray = {
    full_text: '',
    segments: [
      { start: 0, end: 1.5, text: 'First sentence' },
      { start: 1.5, end: 3, text: 'Second sentence' },
    ],
  };
  const second = describeRun({ code: 0, stdout: JSON.stringify({ status: 'ok', data: withArray }), stderr: '' }, {});
  assert.match(second.text, /0\.00-1\.50: First sentence/);
  assert.match(second.text, /1\.50-3\.00: Second sentence/);
});

test('describeRun: an error envelope includes error_code and instruction', () => {
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

test('describeRun: an authentication error explains the login steps', () => {
  const result = { code: 1, stdout: '', stderr: '[ERROR] API key is required. Provide it via:' };
  const described = describeRun(result, { tool: 'web_search' });
  assert.equal(described.ok, false);
  assert.match(described.text, /gsk login/);
});

test('describeRun: exit code 2 explains that confirmation was not approved', () => {
  const result = { code: 2, stdout: '', stderr: '' };
  const described = describeRun(result, { tool: 'slack' });
  assert.match(described.text, /requires confirmation/);
  assert.match(described.text, /approve_write/);
});

test('describeRun: a timeout explains using the run_id path', () => {
  const described = describeRun({ code: null, stdout: '', stderr: '', timedOut: true }, { tool: 'create_task' });
  assert.equal(described.ok, false);
  assert.match(described.text, /task_status/);
});

test('truncate: truncates when over the limit', () => {
  const { text, truncated, originalLength } = truncate('a'.repeat(50), 10);
  assert.equal(truncated, true);
  assert.equal(originalLength, 50);
  assert.match(text, /40 more characters omitted/);
});

// -- catalog.js ---------------------------------------------------------------

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

test('groupOf: prefers cli.path, then group, then ungrouped', () => {
  assert.equal(groupOf({ cli: { path: ['task', 'create'], group: 'x' } }), 'task create');
  assert.equal(groupOf({ cli: { group: 'email' } }), 'email');
  assert.equal(groupOf({ cli: {} }), '(ungrouped)');
});

test('filterTools: keyword searches names, aliases, descriptions, groups, and action names with AND', () => {
  // "search" matches both web_search (name) and slack (action: search)
  assert.deepEqual(
    filterTools(FIXTURE.tools, { keyword: 'search' }).map((t) => t.name).sort(),
    ['slack', 'web_search'],
  );
  assert.equal(filterTools(FIXTURE.tools, { keyword: 'slack send' })[0].name, 'slack');
  assert.equal(filterTools(FIXTURE.tools, { group: 'email' })[0].name, 'gmail');
});

test('summarizeCatalog: with no arguments returns group counts and key tools', () => {
  const text = summarizeCatalog(FIXTURE, {});
  assert.match(text, /3 tools in total/);
  assert.match(text, /web_search/);
});

test('describeCatalogFull: returns the argument schema and action list', () => {
  const text = describeCatalogFull(FIXTURE, { keyword: 'slack' });
  assert.match(text, /action \(required\)/);
  assert.match(text, /send \(approval required\/interactive only\)/);
  assert.match(text, /enum=\[send, search\]/);
});

test('groupSummary: descending by count', () => {
  const summary = groupSummary(FIXTURE.tools);
  assert.deepEqual(summary.map(([name]) => name), ['(ungrouped)', 'email']);
});

// -- tools.js (host-independent assembly) -------------------------------------

test('resolveWritePolicy: defaults to unapproved = --no-input, only --yes when approved', () => {
  assert.deepEqual(resolveWritePolicy({}, false).flags, ['--no-input']);
  assert.deepEqual(resolveWritePolicy({}, true).flags, ['--yes']);
  assert.deepEqual(resolveWritePolicy({ writeMode: 'deny' }, true).flags, ['--no-input']);
  assert.deepEqual(resolveWritePolicy({ writeMode: 'allow' }, false).flags, []);
});

test('schemaRequiresConfirmation: decides whether confirmation is required per action', () => {
  const slack = FIXTURE.tools[1];
  assert.equal(schemaRequiresConfirmation(slack, { action: 'send' }), true);
  assert.equal(schemaRequiresConfirmation(slack, { action: 'search' }), false);
  assert.equal(schemaRequiresConfirmation({ cli: { requires_confirmation: true } }, {}), true);
});

test('buildGensparkTools: returns 4 tool definitions whose parameters match the DSL spec', () => {
  const defineTool = (spec) => spec;
  const tools = buildGensparkTools({ defineTool, getConfig: () => ({}), runner: {}, catalog: {} });
  assert.deepEqual(tools.map((t) => t.name), ['genspark_run', 'genspark_tools', 'genspark_models', 'genspark_status']);
  const run = tools[0];
  assert.equal(run.parameters.tool.required, true);
  assert.equal(run.parameters.args.type, 'json'); // annotation-only schema that accepts arbitrary JSON
  assert.equal(run.parameters.approve_write.type, 'boolean');
  assert.equal(typeof run.execute, 'function');
  // The generation model list can be narrowed by kind (enum is image/video/audio/transcribe)
  const models = tools[2];
  assert.deepEqual(models.parameters.kind.enum, ['image', 'video', 'audio', 'transcribe']);
  assert.equal(models.parameters.kind.required, undefined);
});

test('createCatalogCache: parses the output of ls and caches it', async () => {
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
  assert.equal(calls.length, 1); // the second call is cached
  await cache.load(runner, { refresh: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['--output', 'json', '--refresh', 'ls']);
});

test('createCatalogCache: fails with GSK_CATALOG_UNAVAILABLE when the output cannot be parsed', async () => {
  const runner = { async run() {
    return { code: 1, stdout: '', stderr: '[ERROR] API key is required.' };
  } };
  const cache = createCatalogCache({ getConfig: () => ({}) });
  await assert.rejects(() => cache.load(runner, {}), /Could not retrieve the catalog/);
});

// -- Temporary directory (regression test for --args-file ENOENT on the real DSH host) --

test('resolveTmpRoot: empty string, unset, and whitespace fall back to the OS temp area (absolute path)', () => {
  assert.equal(resolveTmpRoot(''), tmpdir());
  assert.equal(resolveTmpRoot(undefined), tmpdir());
  assert.equal(resolveTmpRoot(null), tmpdir());
  assert.equal(resolveTmpRoot('   '), tmpdir());
  assert.equal(resolveTmpRoot(123), tmpdir());
  assert.equal(isAbsolute(tmpdir()), true);
});

test('resolveTmpRoot: relative input is normalized to an absolute path (not dependent on the child process cwd)', () => {
  const out = resolveTmpRoot('tmp/genspark');
  assert.equal(isAbsolute(out), true);
  assert.equal(out, resolve('tmp/genspark'));
  assert.equal(resolveTmpRoot('C:\\Temp\\genspark'), 'C:\\Temp\\genspark');
});

test('writeArgsFile: returns an absolute path even for a relative directory, and the content is readable as JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-genspark-args-unit-'));
  try {
    const rel = relative(process.cwd(), dir);
    const path = await writeArgsFile(rel, { q: 'test', n: 2 });
    assert.equal(isAbsolute(path), true);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { q: 'test', n: 2 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('describeRun: does not misdiagnose --args-file ENOENT as a wrong argument name', () => {
  const result = {
    code: 1,
    ok: false,
    stdout: '',
    stderr: "[ERROR] --args-file: cannot read dsh-genspark-args-x\\args.json: ENOENT: no such file or directory, open 'C:\\w\\dsh-genspark-args-x\\args.json'",
  };
  const described = describeRun(result, { tool: 'web_search' });
  assert.equal(described.ok, false);
  assert.match(described.text, /could not read the arguments file/i);
  assert.doesNotMatch(described.text, /argument names do not match the Genspark-side schema/i);
});

test('describeRun: "is not a param" still explains a wrong argument name as before', () => {
  const described = describeRun(
    { code: 1, ok: false, stdout: '', stderr: '[ERROR] --args-file: "freshness" is not a param' },
    { tool: 'web_search' },
  );
  assert.match(described.text, /argument names do not match the Genspark-side schema/i);
  assert.match(described.text, /server was not called/i);
});

/** Minimal catalog with the enum of generation models. */
const MODEL_FIXTURE = {
  tools: [
    { name: 'image_generation', parameters: { properties: { model: { enum: ['img-1', 'img-2'] } } } },
    { name: 'video_generation', parameters: { properties: { model: { enum: ['kling/v3'] } } } },
    { name: 'audio_generation', parameters: { properties: {} } }, // no model argument -> not listed
  ],
};

test('collectModels: picks only the model enums from the catalog and drops tools without a model argument', () => {
  const entries = collectModels(MODEL_FIXTURE);
  assert.deepEqual(entries.map((entry) => entry.kind), ['image', 'video']);
  assert.deepEqual(entries[0].ids, ['img-1', 'img-2']);
  assert.equal(entries[0].command, '/genspark-image');
  assert.equal(entries[0].toolName, 'genspark_generate_image');
  assert.deepEqual(collectModels({ tools: [] }), []);
});

test('formatModelList: narrows by kind and substring, and appends a hint line', () => {
  const entries = collectModels(MODEL_FIXTURE);
  assert.match(formatModelList(entries, { kind: 'video' }), /kling\/v3/);
  assert.doesNotMatch(formatModelList(entries, { kind: 'video' }), /img-1/);
  assert.match(formatModelList(entries, { filter: 'img-' }), /img-1 \/ img-2/);
  assert.match(formatModelList(entries), /get_model_info/);
  assert.match(formatModelList(entries, { filter: 'zzz' }), /No matching models were found/);
});

test('kindOfInput: accepts Japanese and aliases, undefined for unknown words', () => {
  assert.equal(kindOfInput('\u52d5\u753b'), 'video');
  assert.equal(kindOfInput('\u753b\u50cf'), 'image');
  assert.equal(kindOfInput(' \u97f3\u58f0 '), 'audio');
  assert.equal(kindOfInput('\u6587\u5b57\u8d77\u3053\u3057'), 'transcribe');
  assert.equal(kindOfInput('kling'), undefined);
  assert.equal(kindOfInput(''), undefined);
});

// -- guard.js (false-positive guard for generation commands) ------------------

test('detectMetaIntent: picks up requests for a model list', () => {
  assert.deepEqual(detectMetaIntent('\u52d5\u753b\u30e2\u30c7\u30eb\u306e\u30ea\u30b9\u30c8\u304f\u3060\u3055\u3044'), { kind: 'models' });
  assert.deepEqual(detectMetaIntent('\u52d5\u753b\u30e2\u30c7\u30eb\u306e\u4e00\u89a7'), { kind: 'models' });
  assert.deepEqual(detectMetaIntent('\u4f7f\u3048\u308b\u52d5\u753b\u30e2\u30c7\u30eb\u3092\u6559\u3048\u3066'), { kind: 'models' });
  assert.deepEqual(detectMetaIntent('\u52d5\u753b\u30e2\u30c7\u30eb'), { kind: 'models' });
  assert.deepEqual(detectMetaIntent('which video models are available'), { kind: 'models' });
});

test('detectMetaIntent: does not pick up ordinary generation prompts', () => {
  assert.equal(detectMetaIntent('\u30e2\u30c7\u30eb\u306e\u3088\u3046\u306a\u5973\u6027\u304c\u6b69\u304f\u52d5\u753b'), undefined);
  assert.equal(detectMetaIntent('\u30e2\u30c7\u30eb\u306e\u5199\u771f\u3092\u4f5c\u3063\u3066\u304f\u3060\u3055\u3044'), undefined);
  assert.equal(detectMetaIntent('\u685c\u306e\u82b1\u3073\u3089\u304c\u821e\u3046 5 \u79d2'), undefined);
  assert.equal(detectMetaIntent(''), undefined);
});

test('detectMetaIntent: picks up usage requests as usage', () => {
  assert.deepEqual(detectMetaIntent('\u4f7f\u3044\u65b9'), { kind: 'usage' });
  assert.deepEqual(detectMetaIntent('help'), { kind: 'usage' });
  assert.deepEqual(detectMetaIntent('\u4f55\u304c\u3067\u304d\u308b\uff1f'), { kind: 'usage' });
});

test('isGenerationTool / modelKindOfTool: targets only generation tools', () => {
  assert.equal(isGenerationTool('video_generation'), true);
  assert.equal(isGenerationTool('image_generation'), true);
  assert.equal(isGenerationTool('audio_generation'), true);
  assert.equal(isGenerationTool('understand_images'), false);
  assert.equal(isGenerationTool('web_search'), false);
  assert.equal(modelKindOfTool('video_generation'), 'video');
  assert.equal(modelKindOfTool('understand_images'), undefined);
});
