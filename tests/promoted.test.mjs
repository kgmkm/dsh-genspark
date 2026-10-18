/**
 * Unit tests for the promoted tools (lib/promoted.js). No host and no network required.
 * Run: node tests/promoted.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PROMOTED_CATEGORIES, PROMOTED_TOOLS, buildPromotedTools, describeSavedFile, detectFileFormat, promotedSummary, resolvePromotedCategories, mediaKindOf } from '../lib/promoted.js';

/** Let defineTool pass through so the definition objects can be collected. */
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

// ── Category selection ───────────────────────────────────────────────────────

test('by default it registers the 10 tools for search & research and generated media', () => {
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

test('narrowing the categories leaves only the matching tools', () => {
  assert.equal(collect({ categories: ['search'] }).length, 6);
  assert.equal(collect({ categories: ['media'] }).length, 4);
  assert.equal(collect({ categories: [] }).length, 0);
});

test('unknown categories are ignored and logged', () => {
  const logs = [];
  const tools = collect({ categories: ['search', 'nope'], log: (message) => logs.push(message) });
  assert.equal(tools.length, 6);
  assert.match(logs.join('\n'), /ignoring unknown category "nope"/);
});

test('the social category has 3 tools (X / Instagram / Reddit)', () => {
  assert.ok(Object.hasOwn(PROMOTED_CATEGORIES, 'social'));
  assert.equal(PROMOTED_TOOLS.filter((spec) => spec.category === 'social').length, 3);
});

test('resolvePromotedCategories / promotedSummary', () => {
  assert.deepEqual([...resolvePromotedCategories(['media'])], ['media']);
  assert.match(promotedSummary(['search', 'media']), /search=Search & research 6 tools/);
  assert.match(promotedSummary(['search','media']), /media=Generated media 4 tools/);
  assert.match(promotedSummary(['search']), /media=.*\(disabled\)/);
});

// ── Argument mapping and validation ──────────────────────────────────────────

test('web_search: passes q through as-is and adds --no-input and the timeout', async () => {
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

test('web_search: a missing q returns an error message and does not start the CLI', async () => {
  const calls = [];
  const [tool] = collect({ categories: ['search'], calls });
  const text = await tool.execute({}, EXEC);
  assert.match(text, /q is required\./);
  assert.equal(calls.length, 0);
});

test('crawler: does not send optional arguments that were not specified', async () => {
  const calls = [];
  const tools = collect({ categories: ['search'], calls });
  const crawl = tools.find((tool) => tool.name === 'genspark_crawl');
  await crawl.execute({ url: 'https://example.com', render_js: true }, EXEC);
  assert.deepEqual(calls[0].toolArgs, { url: 'https://example.com', render_js: true });
});

test('crawler: a value that is neither a URL nor a file returns guidance and does not start the CLI', async () => {
  // Measured in practice: passing a free-text question (not a URL) to /genspark-crawl produced
  // "Genspark API error: No content found or crawler failed for …".
  const calls = [];
  const tools = collect({ categories: ['search'], calls });
  const crawl = tools.find((tool) => tool.name === 'genspark_crawl');
  const error = await crawl.execute({ url: 'this is a test. Tell me about the data leak that happened in Japan yesterday' }, EXEC);
  assert.match(error, /http\(s\) URL or the path of an existing local file/);
  assert.match(error, /genspark-search/);
  assert.match(error, /genspark_run/);
  assert.equal(calls.length, 0);
});

test('crawler: accepts the path of an existing local file (the CLI uploads it automatically)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'genspark-crawl-'));
  const file = join(dir, 'page.html');
  writeFileSync(file, '<p>hi</p>');
  const calls = [];
  const tools = collect({ categories: ['search'], calls });
  const crawl = tools.find((tool) => tool.name === 'genspark_crawl');
  await crawl.execute({ url: file }, EXEC);
  assert.deepEqual(calls[0].toolArgs, { url: file });
});

test('crawler: adds the guidance even when the API reports a fetch failure', async () => {
  const tools = collect({
    categories: ['search'],
    runResult: {
      code: 1,
      ok: false,
      stderr: '',
      stdout: JSON.stringify({
        status: 'error',
        message: 'No content found or crawler failed for this is a test Error: Error fetching URL',
      }),
    },
  });
  const crawl = tools.find((tool) => tool.name === 'genspark_crawl');
  const text = await crawl.execute({ url: 'https://example.com/missing' }, EXEC);
  assert.match(text, /Genspark API error/);
  assert.match(text, /web_search/);
});

test('summarize: a value that is neither a URL nor a file returns guidance and does not start the CLI', async () => {
  const calls = [];
  const tools = collect({ categories: ['search'], calls });
  const summarize = tools.find((tool) => tool.name === 'genspark_summarize_document');
  const error = await summarize.execute({ url: 'Summarize the news from yesterday', question: 'What are the key points?' }, EXEC);
  assert.match(error, /http\(s\) URL or the path of an existing local file/);
  assert.equal(calls.length, 0);
});

test('maps_search: engine=maps requires query', async () => {
  const calls = [];
  const tools = collect({ categories: ['search'], calls });
  const maps = tools.find((tool) => tool.name === 'genspark_maps_search');
  const error = await maps.execute({ query_type: 'search', engine: 'maps' }, EXEC);
  assert.match(error, /query \(when engine=maps\) is required/);
  assert.equal(calls.length, 0);

  await maps.execute({ query_type: 'search', engine: 'maps', query: 'cafes around Tokyo Station' }, EXEC);
  assert.deepEqual(calls[0].toolArgs, { query_type: 'search', engine: 'maps', query: 'cafes around Tokyo Station' });
});

test('maps_search: engine=maps_directions requires start_addr and end_addr', async () => {
  const tools = collect({ categories: ['search'] });
  const maps = tools.find((tool) => tool.name === 'genspark_maps_search');
  assert.match(await maps.execute({ query_type: 'directions', engine: 'maps_directions', start_addr: 'Tokyo Station' }, EXEC), /end_addr/);
});

test('generate_image: requires either query or image_urls', async () => {
  const tools = collect({ categories: ['media'] });
  const image = tools.find((tool) => tool.name === 'genspark_generate_image');
  assert.match(await image.execute({ aspect_ratio: '1:1' }, EXEC), /query \(a description of what to generate\) or image_urls/);
});

test('generate_image: can run with reference images alone (image-to-image)', async () => {
  const calls = [];
  const tools = collect({ categories: ['media'], calls });
  const image = tools.find((tool) => tool.name === 'genspark_generate_image');
  await image.execute({ image_urls: ['https://example.com/a.png'], aspect_ratio: 'auto' }, EXEC);
  assert.deepEqual(calls[0].toolArgs, { image_urls: ['https://example.com/a.png'], aspect_ratio: 'auto' });
});

test('generate_image: save_to becomes an absolute-path -o option and the save result is reported', async () => {
  const calls = [];
  const tools = collect({ categories: ['media'], calls });
  const image = tools.find((tool) => tool.name === 'genspark_generate_image');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-genspark-'));
  const target = join(dir, 'out.png');
  writeFileSync(target, 'dummy');

  const text = await image.execute({ query: 'a red cube', save_to: target }, EXEC);
  assert.deepEqual(calls[0].options.toolArgs, ['-o', target]);
  assert.deepEqual(calls[0].toolArgs, { query: 'a red cube' });
  assert.match(text, /Saved file: .*out\.png \(5 bytes\)/);
});

test('generate_image: a relative save_to resolves against the session cwd', async () => {
  const calls = [];
  const tools = collect({ categories: ['media'], calls });
  const image = tools.find((tool) => tool.name === 'genspark_generate_image');
  await image.execute({ query: 'x', save_to: 'out/a.png' }, { agent: { session: { header: { cwd: 'C:\\work' } } } });
  assert.deepEqual(calls[0].options.toolArgs, ['-o', join('C:\\work', 'out/a.png')]);
});

// ── Saved file format detection ──────────────────────────────────────────────

/** Create a dummy file with the specified leading bytes. */
function writeBytes(name, bytes, tail = '') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-genspark-fmt-'));
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat([Buffer.from(bytes), Buffer.from(tail)]));
  return path;
}

const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01];
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

test('describeSavedFile: when the content is JPEG, renames .png to .jpg and reports it (measured in practice)', () => {
  const path = writeBytes('pic.png', JPEG_HEAD, 'rest');
  const text = describeSavedFile(path);
  const renamed = path.replace(/\.png$/, '.jpg');
  assert.equal(existsSync(path), false, 'the original .png is not kept');
  assert.equal(existsSync(renamed), true, 'renames it to a .jpg that matches the content');
  assert.match(text, /Saved file: .*pic\.jpg \(JPEG \/ 16 bytes\)/);
  assert.match(text, /extension corrected because the actual content is JPEG/);
});

test('describeSavedFile: does not rename when the extension matches the content', () => {
  const path = writeBytes('pic.png', PNG_HEAD, 'rest');
  const text = describeSavedFile(path);
  assert.equal(existsSync(path), true);
  assert.match(text, /Saved file: .*pic\.png \(PNG \/ 12 bytes\)$/);
});

test('describeSavedFile: does not break on an undetectable format (does not print a format)', () => {
  const path = writeBytes('note.txt', [0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  assert.equal(detectFileFormat(path), null);
  assert.match(describeSavedFile(path), /Saved file: .*note\.txt \(5 bytes\)$/);
});

test('describeSavedFile: also detects video and audio formats (ftyp / ID3)', () => {
  const mp4 = writeBytes('clip.mp4', [0x00, 0x00, 0x00, 0x18], 'ftypisom');
  assert.equal(detectFileFormat(mp4).format, 'MP4');
  const mp3 = writeBytes('voice.mp3', [0x49, 0x44, 0x33], 'rest');
  assert.equal(detectFileFormat(mp3).format, 'MP3');
});

test('describeSavedFile: returns a message that existence could not be confirmed for a missing file', () => {
  const missing = join(tmpdir(), 'dsh-genspark-does-not-exist', 'x.png');
  assert.match(describeSavedFile(missing), /existence could not be confirmed/);
});

test('generate_video: query and model are required', async () => {
  const calls = [];
  const tools = collect({ categories: ['media'], calls });
  const video = tools.find((tool) => tool.name === 'genspark_generate_video');
  assert.match(await video.execute({ model: 'kling/v3' }, EXEC), /query is required/);
  assert.match(await video.execute({ query: 'a cat surfing' }, EXEC), /model is required/);
  assert.equal(calls.length, 0);

  await video.execute({ query: 'a cat surfing', model: 'kling/v3', audio_enable: true, duration: 5 }, EXEC);
  assert.deepEqual(calls[0].toolArgs, { query: 'a cat surfing', model: 'kling/v3', audio_enable: true, duration: 5 });
  // Video has a long floor (30 minutes)
  assert.deepEqual(calls[0].options.globalArgs, ['--output', 'json', '--timeout', '1800000', '--no-input']);
  assert.equal(calls[0].options.timeoutMs, 1800000);
});

test('generate_audio: prompt is required and params are passed as JSON', async () => {
  const calls = [];
  const tools = collect({ categories: ['media'], calls });
  const audio = tools.find((tool) => tool.name === 'genspark_generate_audio');
  assert.match(await audio.execute({}, EXEC), /prompt is required/);
  await audio.execute({ prompt: 'hello', model: 'alibaba/qwen-audio-3-tts', params: { speed: 1.1 } }, EXEC);
  assert.deepEqual(calls[0].toolArgs, { prompt: 'hello', model: 'alibaba/qwen-audio-3-tts', params: { speed: 1.1 } });
});

test('analyze-media: media is required; images use understand_images, video uses analyze_media, audio uses audio_transcribe', async () => {
  const calls = [];
  const tools = collect({ categories: ['media'], calls });
  const vision = tools.find((tool) => tool.name === 'genspark_analyze_media');
  assert.match(await vision.execute({}, EXEC), /media is required/);
  // URLs are accepted (image)
  await vision.execute({ media: 'https://example.com/photo.jpg' }, EXEC);
  assert.equal(calls[0].toolName, 'understand_images');
  assert.deepEqual(calls[0].toolArgs, { image_urls: ['https://example.com/photo.jpg'], instruction: 'Describe the content of this media in detail, in the same language the user is using.' });
  calls.length = 0;
  // Video extensions go to analyze_media
  await vision.execute({ media: 'https://example.com/clip.mp4', instruction: 'What is in the video?' }, EXEC);
  assert.equal(calls[0].toolName, 'analyze_media');
  assert.deepEqual(calls[0].toolArgs, { media_urls: ['https://example.com/clip.mp4'], requirements: 'What is in the video?' });
  calls.length = 0;
  // Audio extensions go to audio_transcribe
  await vision.execute({ media: 'https://example.com/voice.mp3' }, EXEC);
  assert.equal(calls[0].toolName, 'audio_transcribe');
  assert.deepEqual(calls[0].toolArgs, { audio_urls: ['https://example.com/voice.mp3'] });
  calls.length = 0;
  // An existing local image file
  const dir = mkdtempSync(join(tmpdir(), 'genspark-analyze-media-'));
  const file = join(dir, 'test.jpg');
  writeFileSync(file, 'dummy');
  await vision.execute({ media: file, instruction: 'Count the cats' }, EXEC);
  assert.equal(calls[0].toolName, 'understand_images');
  assert.deepEqual(calls[0].toolArgs, { image_urls: [file], instruction: 'Count the cats' });
});

test('analyze-media: errors on a nonexistent local path that is not a URL', async () => {
  const tools = collect({ categories: ['media'] });
  const vision = tools.find((tool) => tool.name === 'genspark_analyze_media');
  assert.match(await vision.execute({ media: 'this is a test' }, EXEC), /http\(s\) URL or the path of an existing local file/);
});

test('analyze-media: media_list (command attachments) is routed by kind', () => {
  const spec = PROMOTED_TOOLS.find((tool) => tool.name === 'genspark_analyze_media');
  const images = spec.build({ media_list: ['https://example.com/a.png', 'https://example.com/b.jpg'], instruction: 'Compare them' });
  assert.equal(images.gsk, 'understand_images');
  assert.deepEqual(images.args, {
    image_urls: ['https://example.com/a.png', 'https://example.com/b.jpg'],
    instruction: 'Compare them',
  });

  const video = spec.build({ media_list: ['https://example.com/clip.mp4'], instruction: 'What is in the video?' });
  assert.equal(video.gsk, 'analyze_media');
  assert.deepEqual(video.args, { media_urls: ['https://example.com/clip.mp4'], requirements: 'What is in the video?' });

  const audio = spec.build({ media_list: ['https://example.com/voice.mp3'] });
  assert.equal(audio.gsk, 'audio_transcribe');
  assert.deepEqual(audio.args, { audio_urls: ['https://example.com/voice.mp3'] });

  // If any image is mixed in, it is treated as images (finishes in a single call)
  const mixed = spec.build({ media_list: ['https://example.com/clip.mp4', 'https://example.com/a.png'] });
  assert.equal(mixed.gsk, 'understand_images');
  assert.deepEqual(mixed.args.image_urls, ['https://example.com/a.png']);
});

test('mediaKindOf: classifies by extension (URLs with a query string work too)', () => {
  assert.equal(mediaKindOf('https://example.com/a.JPG'), 'image');
  assert.equal(mediaKindOf('https://example.com/v.mp4?token=abc'), 'video');
  assert.equal(mediaKindOf('https://example.com/a.m4a#t=1'), 'audio');
  assert.equal(mediaKindOf('C:\\tmp\\noext'), 'image');
});

test('extra does not override typed arguments (typed arguments take precedence)', async () => {
  const calls = [];
  const [tool] = collect({ categories: ['search'], calls });
  await tool.execute({ q: 'typed', extra: { q: 'extra', limit: 5 } }, EXEC);
  assert.deepEqual(calls[0].toolArgs, { q: 'typed', limit: 5 });
});

// ── Formatting execution results ─────────────────────────────────────────────

test('an error envelope is formatted as a failure', async () => {
  const tools = collect({
    categories: ['search'],
    runResult: { code: 1, stdout: JSON.stringify({ status: 'error', message: 'quota exceeded', error_code: 'E_Q' }), stderr: '' },
  });
  const [tool] = tools;
  const text = await tool.execute({ q: 'x' }, EXEC);
  assert.match(text, /quota exceeded/);
  assert.match(text, /E_Q/);
});

test('a missing CLI entry returns the guidance as-is', async () => {
  const tools = buildPromotedTools({
    defineTool: (spec) => spec,
    getConfig: () => ({}),
    runner: {
      async runTool() {
        const error = new Error('The @genspark/cli entry was not found.');
        error.code = 'GSK_ENTRY_NOT_FOUND';
        throw error;
      },
    },
    categories: ['search'],
  });
  assert.match(await tools[0].execute({ q: 'x' }, EXEC), /@genspark\/cli entry was not found/);
});
