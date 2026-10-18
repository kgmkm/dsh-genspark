// ホスト実物の dsh-tools（app.asar から抽出）で昇格ツールのスキーマを検証するプリフライト。
// 目的: プラグイン読み込み時に defineTool が例外を投げると全ツールが失われるため、
//       再起動の前に parameters DSL と引数検証を実際の実装で通しておく。
//
// 使い方: node tests/preflight-host-schema.mjs
// 前提  : reference/asar/node_modules/@deepseek-ai/dsh-tools（probe/asar-extract.mjs で抽出済み）
//         @deepseek-ai/dsh-llm は HarnessError だけのスタブ（reference/asar 内）

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

// --- サンプル引数（各ツールの「最小の正しい呼び出し」） ---------------------------
const SAMPLES = {
  genspark_web_search: { q: 'DeepSeek Harness' },
  genspark_image_search: { query: 'red panda' },
  genspark_crawl: { url: 'https://example.com', render_js: true },
  genspark_scholar_search: { query: 'kv cache compression' },
  genspark_maps_search: { engine: 'maps', query_type: 'place', query: '東京駅' },
  genspark_maps_search_directions: {
    name: 'genspark_maps_search',
    args: { engine: 'maps_directions', query_type: 'directions', start_addr: '東京駅', end_addr: '新宿駅' },
  },
  genspark_summarize_document: { url: 'https://example.com/report.pdf', question: '要点は？' },
  genspark_generate_image: { query: '猫のイラスト', model: 'gpt-image-2' },
  genspark_generate_image_i2i: {
    name: 'genspark_generate_image',
    args: { image_urls: ['https://example.com/a.png'], save_to: 'out/a.png' },
  },
  genspark_generate_video: { query: '海辺の夕日', model: 'kling/v3' },
  genspark_generate_audio: { prompt: 'こんにちは', audio_type: 'speech', params: { speed: 1 } },
  genspark_analyze_media: { media: 'https://example.com/photo.jpg', instruction: '何が写っている？' },
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

console.log(`defineTool を通過したツール: ${tools.length} 件`);
for (const tool of tools) {
  const json = tool.parameters;
  const required = Array.isArray(json.required) ? json.required.join(', ') : '(なし)';
  console.log(`  ✔ ${tool.name} → required: ${required}`);
  ok += 1;
}

// --- 実行時検証（validateJsonSchemaValue 経由） ---------------------------------
const byName = new Map(tools.map((t) => [t.name, t]));
const exec = { agent: { session: { header: { cwd: root } } } };

for (const [label, sample] of Object.entries(SAMPLES)) {
  const name = sample.name ?? label;
  const args = sample.name === undefined ? sample : sample.args;
  const tool = byName.get(name);
  if (tool === undefined) {
    console.log(`  ✘ ${label}: ツール ${name} が登録されていない`);
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

// --- 不正な引数がホスト側の検証で弾かれるか -------------------------------------
const negatives = [
  ['enum 違反 (audio_type)', 'genspark_generate_audio', { prompt: 'x', audio_type: 'podcast' }],
  ['型違反 (render_js)', 'genspark_crawl', { url: 'https://example.com', render_js: 'yes' }],
  ['必須欠落 (q)', 'genspark_web_search', {}],
];
for (const [label, name, args] of negatives) {
  const tool = byName.get(name);
  try {
    await tool.execute(args, exec);
    console.log(`  ✘ ${label}: 弾かれなかった（検証が効いていない）`);
    fail += 1;
  } catch (error) {
    console.log(`  ✔ ${label}: ${String(error?.name)} で拒否`);
    ok += 1;
  }
}

// --- 参考: DSL から生成された JSON Schema を 1 つ表示 -----------------------------
console.log('\n参考: genspark_generate_video の JSON Schema（DSL がコンパイルされた結果）');
console.log(JSON.stringify(byName.get('genspark_generate_video').parameters, null, 2).split('\n').slice(0, 40).join('\n'));

console.log(`\n結果: 成功 ${ok} / 失敗 ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
