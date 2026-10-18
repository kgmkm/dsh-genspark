/**
 * Real-CLI integration test for the promoted tools (category-curated typed tools).
 *
 * Run:
 *   node tests/promoted-integration.mjs                        … read-only only (free)
 *   node tests/promoted-integration.mjs --with-generation      … also runs image/audio generation (spends credits)
 *   node tests/promoted-integration.mjs --with-generation --with-video … also runs video generation (expensive)
 *
 * Tests for generated media also verify local saving via `-o/--output-file`
 * (the most fragile path in the plugin).
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
// Plugin-produced error output starts with one of these prefixes; successful output starts with data.
const ERROR_OUTPUT = /^(?:Genspark API error|Could not|Execution failed|An unexpected error|The argument names do not match)/;
const failedText = (text) => ERROR_OUTPUT.test(String(text));

if (!runner.resolveEntry()) {
  console.error('CLI entry not found (npm install -g @genspark/cli is required)');
  process.exit(1);
}

// 1) Number of registered tools
record('Number of registered promoted tools', tools.length === 10, `${tools.length} items: ${tools.map((t) => t.name).join(', ')}`);

// 2) Web search (real search)
const search = await byName.get('genspark_web_search').execute({ q: 'DeepSeek Harness' }, exec);
record('genspark_web_search', /result|url|title/i.test(search) && !failedText(search), flat(search));

// 3) Image search
const imageSearch = await byName.get('genspark_image_search').execute({ query: 'Eiffel Tower at sunset' }, exec);
record('genspark_image_search', !failedText(imageSearch), flat(imageSearch));

// 4) Scholar search (confirm it works without --project-id even though requires_project is set)
const scholar = await byName.get('genspark_scholar_search').execute({ query: 'diffusion model speech synthesis' }, exec);
record('genspark_scholar_search', !failedText(scholar) && !/project/i.test(scholar.slice(0, 200)), flat(scholar));

// 5) analyze-media (media analysis) — real run on a sample image
const vision = await byName.get('genspark_analyze_media').execute({ media: 'D:\\Documents\\deepseek-harness\\default-workspace\\genspark-out\\test_cat.jpg' }, exec);
record('genspark_analyze_media', /cat|analysis/i.test(vision) && !failedText(vision), flat(vision));

// 6) Argument validation rejects without launching the CLI
const invalid = await byName.get('genspark_maps_search').execute({ query_type: 'search', engine: 'maps' }, exec);
record('Argument validation (maps_search) rejects invalid input without launching the CLI', /is required/.test(invalid), flat(invalid));

// 7) Argument names absent from the schema are rejected by the CLI before the server call (no credit spend, clear guidance)
const unknownArg = await byName.get('genspark_web_search').execute({ q: 'Genspark AI', extra: { no_such_param_xyz: 1 } }, exec);
record(
  'Unknown argument names are clearly rejected',
  /do not match/.test(unknownArg) && /no_such_param_xyz/.test(unknownArg),
  flat(unknownArg),
);

// 8) Generated media (spends credits)
if (withGeneration) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-genspark-media-'));
  const imagePath = join(dir, 'image.png');
  const image = await byName
    .get('genspark_generate_image')
    .execute({ query: 'a single red cube on a white background', image_size: '0.5k', save_to: imagePath }, exec);
  const imageSaved = existsSync(imagePath);
  record('genspark_generate_image (-o save)', imageSaved, `${imageSaved ? `${statSync(imagePath).size} bytes ` : ''}${flat(image)}`);

  const audioPath = join(dir, 'audio.mp3');
  const audio = await byName
    .get('genspark_generate_audio')
    .execute({ prompt: 'This is a short read-aloud text for the integration test.', model: 'alibaba/qwen-audio-3-tts', save_to: audioPath }, exec);
  const audioSaved = existsSync(audioPath);
  record('genspark_generate_audio (-o save)', audioSaved, `${audioSaved ? `${statSync(audioPath).size} bytes ` : ''}${flat(audio)}`);

  if (withVideo) {
    const videoPath = join(dir, 'video.mp4');
    const video = await byName
      .get('genspark_generate_video')
      .execute({ query: 'a red cube slowly rotating on a white background', model: 'kling/v3', duration: 5, save_to: videoPath }, exec);
    const videoSaved = existsSync(videoPath);
    record('genspark_generate_video (-o save)', videoSaved, `${videoSaved ? `${statSync(videoPath).size} bytes ` : ''}${flat(video)}`);
  } else {
    console.log('… skipping video generation (add --with-video to run it; expensive)');
  }
} else {
  console.log('… skipping generated-media tests (add --with-generation to run them; spends credits)');
}

// 9) Category definition consistency (every tool belongs to a known category)
record('Category definitions are consistent', PROMOTED_TOOLS.every((spec) => ['search', 'media', 'social'].includes(spec.category)), `${PROMOTED_TOOLS.length} definitions`);

const failed = results.filter((result) => !result.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
process.exit(failed.length === 0 ? 0 : 1);
