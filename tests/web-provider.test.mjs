// Unit tests for the Genspark search provider (lib/web-provider.js).
//
// What is worth pinning down here (each item maps to a way the replacement can break silently):
//   1. Payload mapping 窶・the CLI's shape is not a stable contract, so every alias and the
//      "no URL" / duplicate filters are locked in.
//   2. Failure classification 窶・a 401 or a timeout must surface as WEB_PROVIDER_ERROR with the
//      plugin's existing wording, not as an empty result list.
//   3. `available()` 窶・the seam falls back to "ambiguous" when two providers claim to be usable,
//      so this must be false unless the feature is on *and* the CLI exists.
//   4. The selection handover 窶・writing, restoring, and refusing to fight the user.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GENSPARK_SEARCH_PROVIDER_ID,
  WEB_ABORTED,
  WEB_PROVIDER_ERROR,
  WebProviderError,
  createGensparkSearchProvider,
  createSearchSelectionGuard,
  normalizeWebSearchResult,
  readLive,
} from '../lib/web-provider.js';

/** Live (volatile) reference, as the host hands it to a plugin. */
const live = (value) => ({ get: () => value, set(v) { value = v; } });

/** Envelope-shaped stdout, as lib/gsk-cli.js produces it. */
const okRun = (data, extra = {}) => ({
  code: 0,
  ok: true,
  envelope: { status: 'ok', data },
  data,
  stdout: JSON.stringify({ status: 'ok', data }),
  stderr: '',
  timedOut: false,
  aborted: false,
  args: [],
  ...extra,
});

const errorRun = (message, extra = {}) => {
  const envelope = { status: 'error', message };
  return {
    code: 1,
    ok: false,
    envelope,
    data: envelope,
    stdout: JSON.stringify(envelope),
    stderr: '',
    timedOut: false,
    aborted: false,
    args: [],
    ...extra,
  };
};

/** Recording runner whose `gsk` call resolves to a successful envelope carrying `data`. */
function makeRunner(data = { organic_results: [] }, { entry = 'C:/npm/node_modules/@genspark/cli/dist/index.js' } = {}) {
  return makeRunnerRaw(okRun(data), { entry });
}

/** Recording runner that returns `result` verbatim (for failure shapes). */
function makeRunnerRaw(result, { entry = 'C:/npm/node_modules/@genspark/cli/dist/index.js' } = {}) {
  const calls = [];
  return {
    calls,
    resolveEntry: () => entry,
    async runTool(gsk, args, options) {
      calls.push({ gsk, args, options });
      return result;
    },
  };
}

// --- 1. Payload mapping -----------------------------------------------------------

test('normalizeWebSearchResult maps organic_results onto citeable sources', () => {
  const { sources, content } = normalizeWebSearchResult({
    organic_results: [
      { title: 'Introducing DeepSeek Harness', url: 'https://example.com/a', snippet: 'How to build a plugin' },
      { title: 'Second item', link: 'https://example.com/b', description: 'Alias for snippet' },
    ],
    related_searches: ['dsh plugin'],
  });
  assert.equal(content, undefined);
  assert.deepEqual(sources, [
    { url: 'https://example.com/a', title: 'Introducing DeepSeek Harness', snippet: 'How to build a plugin' },
    { url: 'https://example.com/b', title: 'Second item', snippet: 'Alias for snippet' },
  ]);
});

test('normalizeWebSearchResult accepts other list keys and a bare array', () => {
  assert.deepEqual(normalizeWebSearchResult({ results: [{ url: 'https://example.com/r' }] }).sources, [
    { url: 'https://example.com/r' },
  ]);
  assert.deepEqual(normalizeWebSearchResult([{ url: 'https://example.com/bare' }]).sources, [
    { url: 'https://example.com/bare' },
  ]);
  assert.deepEqual(
    normalizeWebSearchResult({ data: { items: [{ url: 'https://example.com/nested' }] } }).sources,
    [{ url: 'https://example.com/nested' }],
  );
});

test('normalizeWebSearchResult drops records without a usable http(s) URL', () => {
  const { sources } = normalizeWebSearchResult({
    organic_results: [
      { title: 'no url at all' },
      { title: 'relative', url: '/docs/plugin' },
      { title: 'mailto', url: 'mailto:someone@example.com' },
      { title: 'ok', url: 'https://example.com/ok' },
    ],
  });
  assert.deepEqual(sources, [{ url: 'https://example.com/ok', title: 'ok' }]);
});

test('normalizeWebSearchResult deduplicates by URL, keeping the first record', () => {
  const { sources } = normalizeWebSearchResult({
    organic_results: [
      { title: 'first', url: 'https://example.com/x' },
      { title: 'duplicate', url: 'https://example.com/x' },
    ],
  });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].title, 'first');
});

test('normalizeWebSearchResult normalizes a parseable date and drops prose dates', () => {
  const { sources } = normalizeWebSearchResult({
    organic_results: [
      { url: 'https://example.com/dated', date: '2026-10-18T03:00:00Z' },
      { url: 'https://example.com/prose', date: '2 days ago' },
    ],
  });
  assert.equal(sources[0].publishedAt, '2026-10-18T03:00:00.000Z');
  assert.equal(sources[1].publishedAt, undefined);
});

test('normalizeWebSearchResult carries provider answer text as content', () => {
  const { sources, content } = normalizeWebSearchResult({
    organic_results: [{ url: 'https://example.com/a' }],
    answer: 'DeepSeek Harness is a plugin host.',
  });
  assert.equal(content, 'DeepSeek Harness is a plugin host.');
  assert.equal(sources.length, 1);
});

// --- 2. Provider surface ----------------------------------------------------------

test('provider id is stable (the value written into web.searchProvider)', () => {
  const provider = createGensparkSearchProvider({ getConfig: () => ({}), runner: makeRunner() });
  assert.equal(provider.id, GENSPARK_SEARCH_PROVIDER_ID);
  assert.equal(provider.id, 'genspark');
});

test('available() is false while the feature is off, even with the CLI present', () => {
  const provider = createGensparkSearchProvider({
    getConfig: () => ({ webSearch: { enabled: live(false) } }),
    runner: makeRunner(),
  });
  assert.equal(provider.available(), false);
});

test('available() is false when enabled but the CLI entry is missing', () => {
  const provider = createGensparkSearchProvider({
    getConfig: () => ({ webSearch: { enabled: live(true) } }),
    runner: makeRunner(undefined, { entry: null }),
  });
  assert.equal(provider.available(), false);
});

test('available() is true when enabled and the CLI entry exists', () => {
  const provider = createGensparkSearchProvider({
    getConfig: () => ({ webSearch: { enabled: live(true) } }),
    runner: makeRunner(),
  });
  assert.equal(provider.available(), true);
});

test('available() reads the volatile reference, not the wrapper object', () => {
  const config = { webSearch: { enabled: live(false) } };
  const provider = createGensparkSearchProvider({ getConfig: () => config, runner: makeRunner() });
  assert.equal(provider.available(), false);
  config.webSearch.enabled.set(true);
  assert.equal(provider.available(), true);
});

test('search() runs gsk web_search with the query and maps the sources', async () => {
  const runner = makeRunner({
    organic_results: [{ title: 'Hit', url: 'https://example.com/hit', snippet: 'body' }],
  });
  const provider = createGensparkSearchProvider({
    getConfig: () => ({ webSearch: { enabled: live(true) } }),
    runner,
  });
  const result = await provider.search({ query: '  DeepSeek Harness plugin  ', maxResults: 5 });
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].gsk, 'web_search');
  assert.deepEqual(runner.calls[0].args, { q: 'DeepSeek Harness plugin' });
  assert.equal(runner.calls[0].options.timeoutMs, 300000);
  assert.deepEqual(result.sources, [
    { url: 'https://example.com/hit', title: 'Hit', snippet: 'body' },
  ]);
  assert.equal(result.truncated, false);
});

test('search() forwards the cancellation signal to the runner', async () => {
  const runner = makeRunner({ organic_results: [{ url: 'https://example.com/hit' }] });
  const provider = createGensparkSearchProvider({
    getConfig: () => ({ webSearch: { enabled: live(true) } }),
    runner,
  });
  const controller = new AbortController();
  await provider.search({ query: 'x' }, controller.signal);
  assert.equal(runner.calls[0].options.signal, controller.signal);
});

test('search() rejects an empty query before spending credits', async () => {
  const runner = makeRunner();
  const provider = createGensparkSearchProvider({
    getConfig: () => ({ webSearch: { enabled: live(true) } }),
    runner,
  });
  await assert.rejects(() => provider.search({ query: '   ' }), (error) => {
    assert.ok(error instanceof WebProviderError);
    assert.equal(error.code, WEB_PROVIDER_ERROR);
    return true;
  });
  assert.equal(runner.calls.length, 0);
});

test('search() reports an already-aborted signal without starting the CLI', async () => {
  const runner = makeRunner();
  const provider = createGensparkSearchProvider({
    getConfig: () => ({ webSearch: { enabled: live(true) } }),
    runner,
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => provider.search({ query: 'x' }, controller.signal), (error) => {
    assert.equal(error.code, WEB_ABORTED);
    return true;
  });
  assert.equal(runner.calls.length, 0);
});

test('search() maps an aborted run to WEB_ABORTED', async () => {
  const runner = makeRunnerRaw(okRun({ organic_results: [] }, { aborted: true }));
  const provider = createGensparkSearchProvider({
    getConfig: () => ({ webSearch: { enabled: live(true) } }),
    runner,
  });
  await assert.rejects(() => provider.search({ query: 'x' }), (error) => {
    assert.equal(error.code, WEB_ABORTED);
    return true;
  });
});

test('search() surfaces a CLI failure with the plugin wording and the auth hint', async () => {
  const runner = makeRunnerRaw({
    ...errorRun('DeepSeek API error (HTTP 401): Authentication Fails, Your api key: sdaf is invalid'),
    stderr: 'API key is required',
  });
  const provider = createGensparkSearchProvider({
    getConfig: () => ({ webSearch: { enabled: live(true) } }),
    runner,
  });
  await assert.rejects(() => provider.search({ query: 'x' }), (error) => {
    assert.equal(error.code, WEB_PROVIDER_ERROR);
    assert.match(error.message, /Genspark API error/);
    assert.match(error.message, /gsk login/);
    return true;
  });
});

test('search() reports a timeout as a provider failure instead of an empty list', async () => {
  const runner = makeRunnerRaw({ ...okRun({}), ok: false, timedOut: true, stdout: '', envelope: undefined, data: undefined });
  const provider = createGensparkSearchProvider({
    getConfig: () => ({ webSearch: { enabled: live(true) } }),
    runner,
  });
  await assert.rejects(() => provider.search({ query: 'x' }), (error) => {
    assert.equal(error.code, WEB_PROVIDER_ERROR);
    assert.match(error.message, /did not finish within the time limit/);
    return true;
  });
});

test('search() reports a launch failure (missing CLI) with the install hint', async () => {
  const provider = createGensparkSearchProvider({
    getConfig: () => ({ webSearch: { enabled: live(true) } }),
    runner: {
      resolveEntry: () => 'C:/missing/dist/index.js',
      async runTool() {
        const error = new Error('The @genspark/cli entry was not found.');
        error.code = 'GSK_ENTRY_NOT_FOUND';
        throw error;
      },
    },
  });
  await assert.rejects(() => provider.search({ query: 'x' }), (error) => {
    assert.equal(error.code, WEB_PROVIDER_ERROR);
    assert.match(error.message, /could not start/);
    assert.match(error.message, /npm install -g @genspark\/cli/);
    return true;
  });
});

test('search() treats zero results as a provider failure with guidance', async () => {
  const runner = makeRunner({ organic_results: [] });
  const provider = createGensparkSearchProvider({
    getConfig: () => ({ webSearch: { enabled: live(true) } }),
    runner,
  });
  await assert.rejects(() => provider.search({ query: 'q' }), (error) => {
    assert.equal(error.code, WEB_PROVIDER_ERROR);
    assert.match(error.message, /returned no results/);
    return true;
  });
});

test('search() returns answer-only payloads as content instead of failing', async () => {
  const runner = makeRunner({ answer: 'Short answer.' });
  const provider = createGensparkSearchProvider({
    getConfig: () => ({ webSearch: { enabled: live(true) } }),
    runner,
  });
  const result = await provider.search({ query: 'q' });
  assert.deepEqual(result.sources, []);
  assert.equal(result.content, 'Short answer.');
});

// --- 3. readLive ---------------------------------------------------------------

test('readLive unwraps a volatile reference and keeps plain values', () => {
  assert.equal(readLive(live('genspark'), undefined), 'genspark');
  assert.equal(readLive(live(undefined), 'fallback'), 'fallback');
  assert.equal(readLive(false, true), false);
  assert.equal(readLive(undefined, true), true);
});

// --- 4. Selection handover -------------------------------------------------------

/** Fake settings service that records writes against a mutable document. */
function makeSettings(initial = {}) {
  const state = { value: { ...initial }, user: { ...initial }, writes: [], unsets: [] };
  const settings = {
    describe: () => [{ ns: 'web', value: { ...state.value }, user: { ...state.user }, schema: {}, revision: 0 }],
    async update(ns, patch) {
      assert.equal(ns, 'web');
      state.writes.push(patch);
      Object.assign(state.value, patch);
      Object.assign(state.user, patch);
    },
    async mutate(ns, ops) {
      assert.equal(ns, 'web');
      state.unsets.push(ops);
      for (const op of ops) {
        if (op.op === 'unset') delete state.value[op.path[0]];
        else state.value[op.path[0]] = op.value;
      }
    },
  };
  return { settings, state };
}

test('take() writes the provider id and release() clears the field again', async () => {
  const { settings, state } = makeSettings({});
  const guard = createSearchSelectionGuard({ getSettings: () => settings });
  assert.deepEqual(await guard.take(), { applied: true });
  assert.deepEqual(state.writes, [{ searchProvider: 'genspark' }]);
  assert.deepEqual(await guard.release(), { released: true });
  assert.equal(state.unsets.length, 1);
  assert.deepEqual(state.unsets[0], [{ op: 'unset', path: ['searchProvider'] }]);
  assert.equal(state.value.searchProvider, undefined);
});

test('take() is a no-op when the provider is already selected', async () => {
  const { settings, state } = makeSettings({ searchProvider: 'genspark' });
  const guard = createSearchSelectionGuard({ getSettings: () => settings });
  assert.deepEqual(await guard.take(), { applied: true, alreadySelected: true });
  assert.equal(state.writes.length, 0);
});

test('release() restores the explicit choice the user had before', async () => {
  const { settings, state } = makeSettings({ searchProvider: 'deepseek-official' });
  const guard = createSearchSelectionGuard({ getSettings: () => settings });
  await guard.take();
  assert.equal(state.value.searchProvider, 'genspark');
  await guard.release();
  assert.equal(state.value.searchProvider, 'deepseek-official');
  assert.equal(state.unsets.length, 0);
});

test('release() refuses to overwrite a selection the user changed afterwards', async () => {
  const { settings, state } = makeSettings({});
  const guard = createSearchSelectionGuard({ getSettings: () => settings });
  await guard.take();
  state.value.searchProvider = 'deepseek-search-api';
  assert.deepEqual(await guard.release(), { released: false, reason: 'the selection had already changed' });
  assert.equal(state.value.searchProvider, 'deepseek-search-api');
  assert.equal(state.unsets.length, 0);
});

test('take()/release() degrade quietly on a host without the settings service', async () => {
  const guard = createSearchSelectionGuard({ getSettings: () => undefined });
  assert.equal((await guard.take()).applied, false);
  assert.equal((await guard.release()).released, false);
});

test('take() reports a host whose settings service has no "web" entry', async () => {
  const settings = { describe: () => [{ ns: 'other', value: {} }], update: async () => {} };
  const guard = createSearchSelectionGuard({ getSettings: () => settings });
  const outcome = await guard.take();
  assert.equal(outcome.applied, false);
  assert.match(outcome.reason, /no "web" settings entry/);
});
