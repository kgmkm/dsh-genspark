/**
 * 昇格ツール（lib/promoted.js）の単体テスト。ホスト不要・ネットワーク不要。
 * 実行: node tests/promoted.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PROMOTED_CATEGORIES, PROMOTED_TOOLS, buildPromotedTools, describeSavedFile, detectFileFormat, promotedSummary, resolvePromotedCategories, mediaKindOf } from '../lib/promoted.js';

/** defineTool を素通しさせて定義オブジェクトを集める。 */
function collect({ categories, runResult, calls, log } = {}) {
  const tools = buildPromotedTools({
    defineTool: (spec) => spec,
    getConfig: () => ({ timeoutMs: 600000, maxOutputChars: 100000, promotedCategories: categories }),
    runner: {
      async runTool(toolName, toolArgs, options) {
        calls?.push({ toolName, toolArgs, options });
        return (
          runResult ?? {
            code: 0,
            stdout: JSON.stringify({ status: 'ok', message: 'success', data: { echo: toolArgs } }),
            stderr: '',
            ok: true,
          }
        );
      },
    },
    log,
    categories,
  });
  return tools;
}

const EXEC = { agent: { session: { header: { cwd: process.cwd() } } } };

// ── カテゴリ選択 ─────────────────────────────────────────────────────────────

test('既定では検索・調査と生成メディアの 10 ツールを登録する', () => {
  const tools = collect({});
  assert.equal(tools.length, 10);
  const names = tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    'genspark_web_search',
    'genspark_image_search',
    'genspark_crawl',
    'genspark_scholar_search',
    'genspark_maps_search',
    'genspark_summarize_document',
    'genspark_generate_image',
    'genspark_generate_video',
    'genspark_generate_audio',
    'genspark_analyze_media',
  ]);
});

test('カテゴリを絞ると該当ツールだけになる', () => {
  assert.equal(collect({ categories: ['search'] }).length, 6);
  assert.equal(collect({ categories: ['media'] }).length, 4);
  assert.equal(collect({ categories: [] }).length, 0);
});

test('未知のカテゴリは無視してログに出す', () => {
  const logs = [];
  const tools = collect({ categories: ['search', 'nope'], log: (message) => logs.push(message) });
  assert.equal(tools.length, 6);
  assert.match(logs.join('\n'), /未知のカテゴリ "nope"/);
});

test('social カテゴリは 3 ツール（X / Instagram / Reddit）', () => {
  assert.ok(Object.hasOwn(PROMOTED_CATEGORIES, 'social'));
  assert.equal(PROMOTED_TOOLS.filter((spec) => spec.category === 'social').length, 3);
});

test('resolvePromotedCategories / promotedSummary', () => {
  assert.deepEqual([...resolvePromotedCategories(['media'])], ['media']);
  assert.match(promotedSummary(['search', 'media']), /search=検索・調査 6 ツール/);
  assert.match(promotedSummary(['search','media']), /media=生成メディア 4 ツール/);
  assert.match(promotedSummary(['search']), /media=.*（無効）/);
});

// ── 引数のマッピングと検証 ───────────────────────────────────────────────────

test('web_search: q をそのまま渡し、--no-input とタイムアウトを付ける', async () => {
  const calls = [];
  const [tool] = collect({ categories: ['search'], calls });
  const text = await tool.execute({ q: 'latest AI news' }, EXEC);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, 'web_search');
  assert.deepEqual(calls[0].toolArgs, { q: 'latest AI news' });
  assert.deepEqual(calls[0].options.globalArgs, ['--output', 'json', '--timeout', '600000', '--no-input']);
  assert.deepEqual(calls[0].options.toolArgs, []);
  assert.match(text, /latest AI news/);
});

test('web_search: q 未指定はエラー文言を返し、CLI を起動しない', async () => {
  const calls = [];
  const [tool] = collect({ categories: ['search'], calls });
  const text = await tool.execute({}, EXEC);
  assert.match(text, /q は必須です/);
  assert.equal(calls.length, 0);
});

test('crawler: 未指定の任意引数は送らない', async () => {
  const calls = [];
  const tools = collect({ categories: ['search'], calls });
  const crawl = tools.find((tool) => tool.name === 'genspark_crawl');
  await crawl.execute({ url: 'https://example.com', render_js: true }, EXEC);
  assert.deepEqual(calls[0].toolArgs, { url: 'https://example.com', render_js: true });
});

test('crawler: URL でもファイルでもない値は日本語で案内し、CLI を起動しない', async () => {
  // 実機で起きた事象: /genspark-crawl に日本語の質問を渡すと
  // 「Genspark API エラー: No content found or crawler failed for …」になっていた。
  const calls = [];
  const tools = collect({ categories: ['search'], calls });
  const crawl = tools.find((tool) => tool.name === 'genspark_crawl');
  const error = await crawl.execute({ url: 'これはテストです。昨日日本であった情報流出事件を教えてください' }, EXEC);
  assert.match(error, /http\(s\) で始まる URL/);
  assert.match(error, /genspark-search/);
  assert.match(error, /genspark_run/);
  assert.equal(calls.length, 0);
});

test('crawler: 存在するローカルファイルのパスは通す（CLI が自動アップロードする）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'genspark-crawl-'));
  const file = join(dir, 'page.html');
  writeFileSync(file, '<p>hi</p>');
  const calls = [];
  const tools = collect({ categories: ['search'], calls });
  const crawl = tools.find((tool) => tool.name === 'genspark_crawl');
  await crawl.execute({ url: file }, EXEC);
  assert.deepEqual(calls[0].toolArgs, { url: file });
});

test('crawler: API が取得失敗を返したときも日本語の誘導を足す', async () => {
  const tools = collect({
    categories: ['search'],
    runResult: {
      code: 1,
      ok: false,
      stderr: '',
      stdout: JSON.stringify({
        status: 'error',
        message: 'No content found or crawler failed for これはテストです Error: Error fetching URL',
      }),
    },
  });
  const crawl = tools.find((tool) => tool.name === 'genspark_crawl');
  const text = await crawl.execute({ url: 'https://example.com/missing' }, EXEC);
  assert.match(text, /Genspark API エラー/);
  assert.match(text, /web_search/);
});

test('summarize: URL でもファイルでもない値は日本語で案内し、CLI を起動しない', async () => {
  const calls = [];
  const tools = collect({ categories: ['search'], calls });
  const summarize = tools.find((tool) => tool.name === 'genspark_summarize_document');
  const error = await summarize.execute({ url: '昨日のニュースを要約して', question: '要点は？' }, EXEC);
  assert.match(error, /http\(s\) で始まる URL/);
  assert.equal(calls.length, 0);
});

test('maps_search: engine=maps は query 必須', async () => {
  const calls = [];
  const tools = collect({ categories: ['search'], calls });
  const maps = tools.find((tool) => tool.name === 'genspark_maps_search');
  const error = await maps.execute({ query_type: 'search', engine: 'maps' }, EXEC);
  assert.match(error, /query（engine=maps のとき） は必須です/);
  assert.equal(calls.length, 0);

  await maps.execute({ query_type: 'search', engine: 'maps', query: '東京駅のカフェ' }, EXEC);
  assert.deepEqual(calls[0].toolArgs, { query_type: 'search', engine: 'maps', query: '東京駅のカフェ' });
});

test('maps_search: engine=maps_directions は start_addr と end_addr 必須', async () => {
  const tools = collect({ categories: ['search'] });
  const maps = tools.find((tool) => tool.name === 'genspark_maps_search');
  assert.match(await maps.execute({ query_type: 'directions', engine: 'maps_directions', start_addr: '東京駅' }, EXEC), /end_addr/);
});

test('generate_image: query か image_urls のどちらかが必要', async () => {
  const tools = collect({ categories: ['media'] });
  const image = tools.find((tool) => tool.name === 'genspark_generate_image');
  assert.match(await image.execute({ aspect_ratio: '1:1' }, EXEC), /query（生成内容の説明）か image_urls/);
});

test('generate_image: 参照画像だけでも実行できる（image-to-image）', async () => {
  const calls = [];
  const tools = collect({ categories: ['media'], calls });
  const image = tools.find((tool) => tool.name === 'genspark_generate_image');
  await image.execute({ image_urls: ['https://example.com/a.png'], aspect_ratio: 'auto' }, EXEC);
  assert.deepEqual(calls[0].toolArgs, { image_urls: ['https://example.com/a.png'], aspect_ratio: 'auto' });
});

test('generate_image: save_to は絶対パスの -o オプションになり、保存結果を報告する', async () => {
  const calls = [];
  const tools = collect({ categories: ['media'], calls });
  const image = tools.find((tool) => tool.name === 'genspark_generate_image');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-genspark-'));
  const target = join(dir, 'out.png');
  writeFileSync(target, 'dummy');

  const text = await image.execute({ query: 'a red cube', save_to: target }, EXEC);
  assert.deepEqual(calls[0].options.toolArgs, ['-o', target]);
  assert.deepEqual(calls[0].toolArgs, { query: 'a red cube' });
  assert.match(text, /保存ファイル: .*out\.png（5 バイト）/);
});

test('generate_image: 相対の save_to はセッションの cwd 基準で解決する', async () => {
  const calls = [];
  const tools = collect({ categories: ['media'], calls });
  const image = tools.find((tool) => tool.name === 'genspark_generate_image');
  await image.execute({ query: 'x', save_to: 'out/a.png' }, { agent: { session: { header: { cwd: 'C:\\work' } } } });
  assert.deepEqual(calls[0].options.toolArgs, ['-o', join('C:\\work', 'out/a.png')]);
});

// ── 保存ファイルの形式判定 ───────────────────────────────────────────────────

/** 先頭バイトを指定してダミーファイルを作る。 */
function writeBytes(name, bytes, tail = '') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-genspark-fmt-'));
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat([Buffer.from(bytes), Buffer.from(tail)]));
  return path;
}

const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01];
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

test('describeSavedFile: 実体が JPEG なら .png の名前を .jpg に直して報告する（実機で発生）', () => {
  const path = writeBytes('pic.png', JPEG_HEAD, 'rest');
  const text = describeSavedFile(path);
  const renamed = path.replace(/\.png$/, '.jpg');
  assert.equal(existsSync(path), false, '元の .png は残さない');
  assert.equal(existsSync(renamed), true, '実体に合った .jpg へ改名する');
  assert.match(text, /保存ファイル: .*pic\.jpg（JPEG \/ 16 バイト）/);
  assert.match(text, /実体が JPEG のため拡張子を修正/);
});

test('describeSavedFile: 拡張子が実体と合っていれば改名しない', () => {
  const path = writeBytes('pic.png', PNG_HEAD, 'rest');
  const text = describeSavedFile(path);
  assert.equal(existsSync(path), true);
  assert.match(text, /保存ファイル: .*pic\.png（PNG \/ 12 バイト）$/);
});

test('describeSavedFile: 判定できない形式でも壊れない（形式は出さない）', () => {
  const path = writeBytes('note.txt', [0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  assert.equal(detectFileFormat(path), null);
  assert.match(describeSavedFile(path), /保存ファイル: .*note\.txt（5 バイト）$/);
});

test('describeSavedFile: 動画と音声の形式も判定する（ftyp / ID3）', () => {
  const mp4 = writeBytes('clip.mp4', [0x00, 0x00, 0x00, 0x18], 'ftypisom');
  assert.equal(detectFileFormat(mp4).format, 'MP4');
  const mp3 = writeBytes('voice.mp3', [0x49, 0x44, 0x33], 'rest');
  assert.equal(detectFileFormat(mp3).format, 'MP3');
});

test('describeSavedFile: 存在しないファイルは確認できなかった旨を返す', () => {
  const missing = join(tmpdir(), 'dsh-genspark-does-not-exist', 'x.png');
  assert.match(describeSavedFile(missing), /存在を確認できませんでした/);
});

test('generate_video: query と model は必須', async () => {
  const calls = [];
  const tools = collect({ categories: ['media'], calls });
  const video = tools.find((tool) => tool.name === 'genspark_generate_video');
  assert.match(await video.execute({ model: 'kling/v3' }, EXEC), /query は必須です/);
  assert.match(await video.execute({ query: 'a cat surfing' }, EXEC), /model は必須です/);
  assert.equal(calls.length, 0);

  await video.execute({ query: 'a cat surfing', model: 'kling/v3', audio_enable: true, duration: 5 }, EXEC);
  assert.deepEqual(calls[0].toolArgs, { query: 'a cat surfing', model: 'kling/v3', audio_enable: true, duration: 5 });
  // 動画は長い下限（30 分）を持つ
  assert.deepEqual(calls[0].options.globalArgs, ['--output', 'json', '--timeout', '1800000', '--no-input']);
  assert.equal(calls[0].options.timeoutMs, 1800000);
});

test('generate_audio: prompt 必須・params は JSON のまま渡る', async () => {
  const calls = [];
  const tools = collect({ categories: ['media'], calls });
  const audio = tools.find((tool) => tool.name === 'genspark_generate_audio');
  assert.match(await audio.execute({}, EXEC), /prompt は必須です/);
  await audio.execute({ prompt: 'こんにちは', model: 'alibaba/qwen-audio-3-tts', params: { speed: 1.1 } }, EXEC);
  assert.deepEqual(calls[0].toolArgs, { prompt: 'こんにちは', model: 'alibaba/qwen-audio-3-tts', params: { speed: 1.1 } });
});

test('analyze-media: media 必須、画像は understand_images、動画は analyze_media、音声は audio_transcribe', async () => {
  const calls = [];
  const tools = collect({ categories: ['media'], calls });
  const vision = tools.find((tool) => tool.name === 'genspark_analyze_media');
  assert.match(await vision.execute({}, EXEC), /media は必須です/);
  // URL は通す（画像）
  await vision.execute({ media: 'https://example.com/photo.jpg' }, EXEC);
  assert.equal(calls[0].toolName, 'understand_images');
  assert.deepEqual(calls[0].toolArgs, { image_urls: ['https://example.com/photo.jpg'], instruction: 'このメディアの内容を日本語で詳しく説明してください。' });
  calls.length = 0;
  // 動画拡張子は analyze_media
  await vision.execute({ media: 'https://example.com/clip.mp4', instruction: '何が映っている？' }, EXEC);
  assert.equal(calls[0].toolName, 'analyze_media');
  assert.deepEqual(calls[0].toolArgs, { media_urls: ['https://example.com/clip.mp4'], requirements: '何が映っている？' });
  calls.length = 0;
  // 音声拡張子は audio_transcribe
  await vision.execute({ media: 'https://example.com/voice.mp3' }, EXEC);
  assert.equal(calls[0].toolName, 'audio_transcribe');
  assert.deepEqual(calls[0].toolArgs, { audio_urls: ['https://example.com/voice.mp3'] });
  calls.length = 0;
  // 存在するローカル画像ファイル
  const dir = mkdtempSync(join(tmpdir(), 'genspark-analyze-media-'));
  const file = join(dir, 'test.jpg');
  writeFileSync(file, 'dummy');
  await vision.execute({ media: file, instruction: '猫を数えて' }, EXEC);
  assert.equal(calls[0].toolName, 'understand_images');
  assert.deepEqual(calls[0].toolArgs, { image_urls: [file], instruction: '猫を数えて' });
});

test('analyze-media: URL でないローカルパスで存在しないものはエラー', async () => {
  const tools = collect({ categories: ['media'] });
  const vision = tools.find((tool) => tool.name === 'genspark_analyze_media');
  assert.match(await vision.execute({ media: 'これはテストです' }, EXEC), /http\(s\) で始まる URL/);
});

test('analyze-media: media_list（コマンドの添付）は種類ごとに振り分ける', () => {
  const spec = PROMOTED_TOOLS.find((tool) => tool.name === 'genspark_analyze_media');
  const images = spec.build({ media_list: ['https://example.com/a.png', 'https://example.com/b.jpg'], instruction: '比較して' });
  assert.equal(images.gsk, 'understand_images');
  assert.deepEqual(images.args, {
    image_urls: ['https://example.com/a.png', 'https://example.com/b.jpg'],
    instruction: '比較して',
  });

  const video = spec.build({ media_list: ['https://example.com/clip.mp4'], instruction: '何が映っている？' });
  assert.equal(video.gsk, 'analyze_media');
  assert.deepEqual(video.args, { media_urls: ['https://example.com/clip.mp4'], requirements: '何が映っている？' });

  const audio = spec.build({ media_list: ['https://example.com/voice.mp3'] });
  assert.equal(audio.gsk, 'audio_transcribe');
  assert.deepEqual(audio.args, { audio_urls: ['https://example.com/voice.mp3'] });

  // 画像が混ざっていれば画像として扱う（1 回の呼び出しで済ませる）
  const mixed = spec.build({ media_list: ['https://example.com/clip.mp4', 'https://example.com/a.png'] });
  assert.equal(mixed.gsk, 'understand_images');
  assert.deepEqual(mixed.args.image_urls, ['https://example.com/a.png']);
});

test('mediaKindOf: 拡張子で分類する（クエリ付き URL も可）', () => {
  assert.equal(mediaKindOf('https://example.com/a.JPG'), 'image');
  assert.equal(mediaKindOf('https://example.com/v.mp4?token=abc'), 'video');
  assert.equal(mediaKindOf('https://example.com/a.m4a#t=1'), 'audio');
  assert.equal(mediaKindOf('C:\\tmp\\noext'), 'image');
});

test('extra は型付き引数を上書きしない（型付きが優先）', async () => {
  const calls = [];
  const [tool] = collect({ categories: ['search'], calls });
  await tool.execute({ q: 'typed', extra: { q: 'extra', limit: 5 } }, EXEC);
  assert.deepEqual(calls[0].toolArgs, { q: 'typed', limit: 5 });
});

// ── 実行結果の整形 ───────────────────────────────────────────────────────────

test('error エンベロープは失敗として整形される', async () => {
  const tools = collect({
    categories: ['search'],
    runResult: { code: 1, stdout: JSON.stringify({ status: 'error', message: 'quota exceeded', error_code: 'E_Q' }), stderr: '' },
  });
  const [tool] = tools;
  const text = await tool.execute({ q: 'x' }, EXEC);
  assert.match(text, /quota exceeded/);
  assert.match(text, /E_Q/);
});

test('CLI エントリ未検出はそのまま案内を返す', async () => {
  const tools = buildPromotedTools({
    defineTool: (spec) => spec,
    getConfig: () => ({}),
    runner: {
      async runTool() {
        const error = new Error('CLI が見つかりません');
        error.code = 'GSK_ENTRY_NOT_FOUND';
        throw error;
      },
    },
    categories: ['search'],
  });
  assert.match(await tools[0].execute({ q: 'x' }, EXEC), /CLI が見つかりません/);
});
