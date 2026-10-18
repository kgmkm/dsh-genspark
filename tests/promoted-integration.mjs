/**
 * 昇格ツール（カテゴリ厳選の型付きツール）の実 CLI 統合テスト。
 *
 * 実行:
 *   node tests/promoted-integration.mjs                        … 読み取り系のみ（無料）
 *   node tests/promoted-integration.mjs --with-generation      … 画像・音声生成も実行（クレジット消費）
 *   node tests/promoted-integration.mjs --with-generation --with-video … 動画生成も実行（高コスト）
 *
 * 生成メディアのテストは `-o/--output-file` によるローカル保存まで確認する
 * （プラグインで最も壊れやすい経路のため）。
 */
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCatalogCache } from '../lib/catalog.js';
import { createRunner } from '../lib/gsk-cli.js';
import { PROMOTED_TOOLS, buildPromotedTools } from '../lib/promoted.js';

const argv = process.argv.slice(2);
const withGeneration = argv.includes('--with-generation');
const withVideo = argv.includes('--with-video');

const cwd = process.cwd();
const config = { timeoutMs: 600000, maxOutputChars: 20000, writeMode: 'approve', promotedCategories: ['search', 'media'] };
const runner = createRunner({ getConfig: () => config });
const catalog = createCatalogCache({ getConfig: () => config, log: () => {} });
const tools = buildPromotedTools({
  defineTool: (spec) => spec,
  getConfig: () => config,
  runner,
  catalog,
  log: (message) => console.log(message),
});
const byName = new Map(tools.map((tool) => [tool.name, tool]));
const exec = { agent: { session: { header: { cwd } } }, signal: undefined };

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const flat = (text) => String(text).replace(/\s+/g, ' ').slice(0, 140);

if (!runner.resolveEntry()) {
  console.error('CLI エントリが見つかりません（npm install -g @genspark/cli が必要）');
  process.exit(1);
}

// 1) 登録ツール数
record('昇格ツールの登録数', tools.length === 10, `${tools.length} 件: ${tools.map((t) => t.name).join(', ')}`);

// 2) Web 検索（実検索）
const search = await byName.get('genspark_web_search').execute({ q: 'DeepSeek Harness' }, exec);
record('genspark_web_search', /result|url|title/i.test(search) && !/失敗|エラー/.test(search.slice(0, 200)), flat(search));

// 3) 画像検索
const imageSearch = await byName.get('genspark_image_search').execute({ query: 'Eiffel Tower at sunset' }, exec);
record('genspark_image_search', !/失敗|エラー/.test(imageSearch.slice(0, 200)), flat(imageSearch));

// 4) 学術検索（requires_project でも --project-id 無しで動くことの確認）
const scholar = await byName.get('genspark_scholar_search').execute({ query: 'diffusion model speech synthesis' }, exec);
record('genspark_scholar_search', !/失敗|エラー|project/i.test(scholar.slice(0, 200)), flat(scholar));

// 5) モデル情報（動画モデルの params_schema が取れる）
const info = await byName.get('genspark_model_info').execute({ model_names: ['kling/v3'] }, exec);
record('genspark_model_info', /kling|schema|param/i.test(info) && !/失敗|エラー/.test(info.slice(0, 200)), flat(info));

// 6) 引数検証は CLI を起動せずに弾く
const invalid = await byName.get('genspark_maps_search').execute({ query_type: 'search', engine: 'maps' }, exec);
record('引数検証（maps_search）', /必須/.test(invalid), flat(invalid));

// 7) スキーマに無い引数名は CLI がサーバー呼び出し前に拒否する（クレジット消費なし・明確な案内）
const unknownArg = await byName.get('genspark_web_search').execute({ q: 'Genspark AI', extra: { no_such_param_xyz: 1 } }, exec);
record(
  '未知の引数名を明確に拒否',
  /一致しません/.test(unknownArg) && /no_such_param_xyz/.test(unknownArg),
  flat(unknownArg),
);

// 8) 生成メディア（クレジット消費）
if (withGeneration) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-genspark-media-'));
  const imagePath = join(dir, 'image.png');
  const image = await byName
    .get('genspark_generate_image')
    .execute({ query: 'a single red cube on a white background', image_size: '0.5k', save_to: imagePath }, exec);
  const imageSaved = existsSync(imagePath);
  record('genspark_generate_image（-o 保存）', imageSaved, `${imageSaved ? `${statSync(imagePath).size} バイト ` : ''}${flat(image)}`);

  const audioPath = join(dir, 'audio.mp3');
  const audio = await byName
    .get('genspark_generate_audio')
    .execute({ prompt: 'これは統合テスト用の短い読み上げです。', model: 'alibaba/qwen-audio-3-tts', save_to: audioPath }, exec);
  const audioSaved = existsSync(audioPath);
  record('genspark_generate_audio（-o 保存）', audioSaved, `${audioSaved ? `${statSync(audioPath).size} バイト ` : ''}${flat(audio)}`);

  if (withVideo) {
    const videoPath = join(dir, 'video.mp4');
    const video = await byName
      .get('genspark_generate_video')
      .execute({ query: 'a red cube slowly rotating on a white background', model: 'kling/v3', duration: 5, save_to: videoPath }, exec);
    const videoSaved = existsSync(videoPath);
    record('genspark_generate_video（-o 保存）', videoSaved, `${videoSaved ? `${statSync(videoPath).size} バイト ` : ''}${flat(video)}`);
  } else {
    console.log('… 動画生成はスキップ（--with-video を付けると実行。高コスト）');
  }
} else {
  console.log('… 生成メディアのテストはスキップ（--with-generation を付けると実行。クレジット消費）');
}

// 9) カテゴリ定義の整合（全ツールが既知カテゴリに属する）
record('カテゴリ定義の整合', PROMOTED_TOOLS.every((spec) => ['search', 'media', 'social'].includes(spec.category)), `${PROMOTED_TOOLS.length} 定義`);

const failed = results.filter((result) => !result.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 成功 ===`);
process.exit(failed.length === 0 ? 0 : 1);
