// Preflight that validates the promoted-tool schemas with the real host dsh-tools (extracted from app.asar).
// Purpose: if defineTool throws at plugin load time, every tool is lost, so run the parameters DSL and
//          argument validation through the real implementation before a restart.
//
// Usage: node tests/preflight-host-schema.mjs
// Requires: reference/asar/node_modules/@deepseek-ai/dsh-tools (extracted with probe/asar-extract.mjs)
//           @deepseek-ai/dsh-llm is a stub that only provides HarnessError (inside reference/asar)

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const schemaPath = join(
  root,
  'reference/asar/node_modules/@deepseek-ai/dsh-tools/lib/types/schema.js',
);
const { defineTool } = await import(
  new URL(`file://${schemaPath.replace(/\\/g, '/')}`).href
);

const { buildPromotedTools } = await import(
  new URL(`file://${join(here, '..', 'lib', 'promoted.js').replace(/\\/g, '/')}`).href
);

// --- Sample arguments (the "smallest valid call" for each tool) --------------------
const SAMPLES = {
  genspark_web_search: { q: 'DeepSeek Harness' },
  genspark_image_search: { query: 'red panda' },
  genspark_crawl: { url: 'https://example.com', render_js: true },
  genspark_scholar_search: { query: 'kv cache compression' },
  genspark_maps_search: { engine: 'maps', query_type: 'place', query: 'Tokyo Station' },
  genspark_maps_search_directions: {
    name: 'genspark_maps_search',
    args: { engine: 'maps_directions', query_type: 'directions', start_addr: 'Tokyo Station', end_addr: 'Shinjuku Station' },
  },
  genspark_summarize_document: { url: 'https://example.com/report.pdf', question: 'What are the key points?' },
  genspark_generate_image: { query: 'illustration of a cat', model: 'gpt-image-2' },
  genspark_generate_image_i2i: {
    name: 'genspark_generate_image',
    args: { image_urls: ['https://example.com/a.png'], save_to: 'out/a.png' },
  },
  genspark_generate_video: { query: 'sunset by the sea', model: 'kling/v3' },
  genspark_generate_audio: { prompt: 'Hello', audio_type: 'speech', params: { speed: 1 } },
  genspark_analyze_media: { media: 'https://example.com/photo.jpg', instruction: 'What is in this image?' },
};

const categories = ['search', 'media'];
let ok = 0;
let fail = 0;
const calls = [];

const runner = {
  async runTool(gsk, args, opts) {
    calls.push({ gsk, args, opts });
    return { code: 0, ok: true, envelope: { status: 'ok', data: { echo: true } }, stderr: '' };
  },
  resolveRuntime: () => ({ path: 'node', source: 'test' }),
};

const log = { info() {}, warn() {}, error() {}, debug() {} };

const tools = buildPromotedTools({
  defineTool,
  getConfig: () => ({ timeoutMs: 300000 }),
  runner,
  catalog: { load: async () => ({ tools: [] }) },
  log,
  categories,
});

console.log(`Tools that passed defineTool: ${tools.length}`);
for (const tool of tools) {
  const json = tool.parameters;
  const required = Array.isArray(json.required) ? json.required.join(', ') : '(none)';
  console.log(`  ✔ ${tool.name} → required: ${required}`);
  ok += 1;
}

// --- Runtime validation (through validateJsonSchemaValue) ---------------------------
const byName = new Map(tools.map((t) => [t.name, t]));
const exec = { agent: { session: { header: { cwd: root } } } };

for (const [label, sample] of Object.entries(SAMPLES)) {
  const name = sample.name ?? label;
  const args = sample.name === undefined ? sample : sample.args;
  const tool = byName.get(name);
  if (tool === undefined) {
    console.log(`  ✘ ${label}: tool ${name} is not registered`);
    fail += 1;
    continue;
  }
  const before = calls.length;
  try {
    const text = await tool.execute(args, exec);
    const call = calls[before];
    const shown = typeof text === 'string' ? text.split('\n')[0].slice(0, 70) : String(text);
    console.log(`  ✔ ${label} → gsk=${call?.gsk} args=${JSON.stringify(call?.args)}`);
    console.log(`      ${shown}`);
    ok += 1;
  } catch (error) {
    console.log(`  ✘ ${label}: ${error?.message ?? error}`);
    fail += 1;
  }
}

// --- Whether invalid arguments are rejected by host-side validation ----------------
const negatives = [
  ['enum violation (audio_type)', 'genspark_generate_audio', { prompt: 'x', audio_type: 'podcast' }],
  ['type violation (render_js)', 'genspark_crawl', { url: 'https://example.com', render_js: 'yes' }],
  ['missing required (q)', 'genspark_web_search', {}],
];
for (const [label, name, args] of negatives) {
  const tool = byName.get(name);
  try {
    await tool.execute(args, exec);
    console.log(`  ✘ ${label}: was not rejected (validation is not working)`);
    fail += 1;
  } catch (error) {
    console.log(`  ✔ ${label}: rejected with ${String(error?.name)}`);
    ok += 1;
  }
}

// --- Reference: show one JSON Schema generated from the DSL ------------------------
console.log('\nReference: JSON Schema of genspark_generate_video (the compiled DSL result)');
console.log(JSON.stringify(byName.get('genspark_generate_video').parameters, null, 2).split('\n').slice(0, 40).join('\n'));

console.log(`\nResult: ${ok} passed / ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
