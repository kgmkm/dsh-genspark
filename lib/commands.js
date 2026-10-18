/**
 * dsh-genspark — host commands (rows reachable from the composer's `+` menu and `/`).
 *
 * Why commands:
 *   Commands do **not create model messages**. The UI renders result text outside the model history,
 *   so Genspark can be used without consuming the model's context. That is the value of listing
 *   them in the `+` menu (a human-facing entry point for research and generation that keeps the
 *   conversation history clean).
 *
 * Design contract:
 *   - Execution goes through the same path as promoted tools (runner.runTool → gsk <tool> --args-file …).
 *     Arguments are validated by the same build() as promoted tools, so a mismatched argument name
 *     is reported before the CLI is launched.
 *   - Commands have no approval (approve_write) mechanism, so operations with side effects always
 *     run with `--no-input` (= rejected before the server call). Operations that need writes must
 *     go through the genspark_run tool.
 *   - Media generation commands automatically save artifacts under <session cwd>/genspark-out/ and
 *     show the path. `-o` does not validate the extension (measured), so the extension is cosmetic
 *     and follows convention.
 *   - All names use the genspark prefix. Do not collide with existing host commands (compact / model /
 *     permission / export / feedback / goal / plan). Names must match /^[a-z][a-z0-9_-]*$/.
 *   - Which commands are exposed follows the promotedCategories setting (disabling search / media
 *     removes that category's commands). genspark / genspark-tools / genspark-run are always on.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { ENTRY_NOT_FOUND_MESSAGE } from './gsk-cli.js';
import { describeToolFull, filterTools, summarizeCatalog } from './catalog.js';
import { detectMetaIntent, isGenerationTool, modelKindOfTool } from './guard.js';
import { collectModels, formatModelList, kindOfInput } from './models.js';
import { describeSavedFile, PROMOTED_TOOLS, promotedSummary, resolvePromotedCategories } from './promoted.js';
import { describeRun, parseEnvelope, truncate } from './result.js';
import { SOCIAL_DEFAULT_LIMIT, SOCIAL_PLATFORMS } from './social.js';

/** Platform → typed tool name (used by the /genspark-social routing prompt). */
const SOCIAL_TOOL_BY_PLATFORM = {
  x: 'genspark_x_search',
  instagram: 'genspark_instagram_search',
  reddit: 'genspark_reddit_search',
};

/** gsk tool name → promoted tool definition. */
const SPEC_BY_GSK = new Map(PROMOTED_TOOLS.map((spec) => [spec.gsk, spec]));

/**
 * CLI built-in commands (not listed in the catalog) that /genspark-run may execute.
 * `me` is a read-only command returning the account and remaining credits (measured: it is absent from the catalog).
 * Built-in commands with side effects (init-skills / login, etc.) are not allowed.
 */
const CLI_BUILTIN_READONLY = new Set(['me']);

/** Keys picked up as title / URL / text for list display (names differ per tool, so candidates are listed together). */
const TITLE_KEYS = ['title', 'name', 'model_name', 'place_name', 'headline', 'label', 'query'];
const URL_KEYS = ['url', 'link', 'source_url', 'image_url', 'thumbnail_url', 'video_url', 'place_id', 'id'];
const TEXT_KEYS = ['snippet', 'description', 'summary', 'address', 'text', 'content'];
const LIST_KEYS = [
  'organic_results', 'results', 'images', 'local_results', 'places', 'items', 'entries',
  'documents', 'videos', 'papers', 'models', 'data', 'output',
];

/** Get the session working directory from invocation. */
function commandCwd(invocation) {
  return invocation?.agent?.session?.header?.cwd ?? process.cwd();
}

function pickString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

/**
 * Pick a string from an entry. If none is found, look one level into nested objects
 * (e.g. get_model_info returns { model_name, model_info: { name, capabilities, … } }).
 */
function pickFromEntry(entry, keys) {
  const direct = pickString(entry, keys);
  if (direct.length > 0) return direct;
  for (const value of Object.values(entry ?? {})) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const nested = pickString(value, keys);
      if (nested.length > 0) return nested;
    }
  }
  return '';
}

/** Collect the "arrays of strings" an entry (and its nested objects) holds, as `key: a / b / c`. */
function collectStringArrays(entry) {
  const lines = [];
  const scan = (source) => {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')) {
        lines.push(`   ${key}: ${value.slice(0, 6).join(' / ')}`);
      }
    }
  };
  scan(entry);
  for (const value of Object.values(entry ?? {})) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) scan(value);
  }
  return lines;
}

/** Find one list-like array inside data. */
function findList(data) {
  if (Array.isArray(data)) return { key: '', list: data };
  if (data === null || typeof data !== 'object') return null;
  for (const key of LIST_KEYS) if (Array.isArray(data[key])) return { key, list: data[key] };
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.some((entry) => entry !== null && typeof entry === 'object')) {
      return { key, list: value };
    }
  }
  return null;
}

/**
 * Format the API data into a human-readable list.
 * Returns null when no list is found, and the caller falls back to the JSON view.
 */
export function humanizeData(data, { limit = 5, maxChars = 4000 } = {}) {
  const found = findList(data);
  if (found === null) return null;
  const shown = Math.min(limit, found.list.length);
  const lines = [`${found.key || 'items'}: ${found.list.length} items (showing the first ${shown})`];
  found.list.slice(0, shown).forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      lines.push(`${index + 1}. ${String(entry)}`);
      return;
    }
    const title = pickFromEntry(entry, TITLE_KEYS);
    const url = pickFromEntry(entry, URL_KEYS);
    const text = pickFromEntry(entry, TEXT_KEYS);
    const arrays = collectStringArrays(entry);
    if (title.length === 0 && url.length === 0 && text.length === 0 && arrays.length === 0) {
      // When no pickable field exists, show the raw JSON in a single line (e.g. a tool returning an unknown schema)
      lines.push(`${index + 1}. ${truncate(JSON.stringify(entry), 300).text}`);
      return;
    }
    lines.push(`${index + 1}. ${title || '(no title)'}`);
    if (url.length > 0) lines.push(`   ${url}`);
    if (text.length > 0) lines.push(`   ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`);
    lines.push(...arrays);
  });
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string')) {
        lines.push(`${key}: ${value.slice(0, 8).join(' / ')}`);
      }
    }
  }
  return truncate(lines.join('\n'), maxChars).text;
}

/**
 * Tools whose result is "the body itself" (list formatting would drop the body, so `described` is emitted as-is).
 * Example: understand_images data is { results:[{url, result}] }, and list formatting drops `result`.
 */
const TEXTUAL_TOOLS = new Set(['understand_images', 'analyze_media', 'audio_transcribe', 'summarize_large_document']);

/** Pick the first generated item from a generation tool result (to inspect status / failure_reason). */
function firstGenerationItem(data) {
  if (data === null || typeof data !== 'object') return null;
  for (const key of ['generated_videos', 'generated_images', 'generated_audios']) {
    const list = data[key];
    if (Array.isArray(list) && list.length > 0 && list[0] !== null && typeof list[0] === 'object') {
      return list[0];
    }
  }
  return null;
}

/** Pick the first media URL from the generation result (used for saving when the CLI's `-o` fails). */
function firstMediaUrl(data) {
  const seen = new Set();
  const isHttp = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);
  const visit = (value, depth) => {
    if (depth > 4 || value === null || typeof value !== 'object' || seen.has(value)) return '';
    seen.add(value);
    for (const key of ['video_urls', 'image_urls', 'audio_urls', 'video_url', 'image_url', 'url', 'file_wrapper_url']) {
      const candidate = value[key];
      if (isHttp(candidate)) return candidate;
      if (Array.isArray(candidate)) {
        const hit = candidate.find(isHttp);
        if (hit !== undefined) return hit;
      }
    }
    for (const child of Object.values(value)) {
      const hit = visit(child, depth + 1);
      if (hit.length > 0) return hit;
    }
    return '';
  };
  return visit(data, 0);
}

/** Write from a URL to the save path (fallback when the CLI could not fetch it with `-o`). */
async function downloadTo(path, url, log, tool) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error('empty response');
    writeFileSync(path, bytes);
    return true;
  } catch (error) {
    log?.(`[genspark] failed to save ${tool} output (${url}): ${error?.message ?? error}`);
    return false;
  }
}

/** URLs that may be auto-saved (Genspark file delivery). External CDNs are not fetched unasked. */
const SAVABLE_URL_RE = /^https?:\/\/[^/]*genspark\.ai\//i;

/**
 * Explain what to do next from status / failure_reason.
 *
 * Measured (2026-10-18): NSFW videos return `status: FAILURE` plus
 * "Content was rejected by the platform's safety policy. Please adjust your prompt…".
 * Raw English output leaves users unsure how to respond, so classify it and add guidance.
 */
function explainGenerationFailure(status, reason) {
  const haystack = `${status} ${reason}`.toLowerCase();
  if (/safety|policy|moderat|reject|sensitive|nsfw|violat|prohibit|inappropriat/.test(haystack)) {
    return [
      '**Rejected by the safety policy (sensitive-content check).**',
      'What to try: soften the prompt wording / change the input image / try a different model.',
      'Re-running the same prompt produces the same result and may still spend credits.',
    ].join('\n');
  }
  if (/process|pending|queue|wait|in_progress|generat/.test(haystack)) {
    return 'Generation may not have finished yet. Wait a moment, then check the Genspark screen (history).';
  }
  return '';
}

/**
 * Turn the generation-save outcome into one block of copy.
 *
 * Measured (2026-10-18): `/genspark-video` returned in 6 seconds and showed "status: success" with no file.
 * The cause was the CLI **returning without waiting for completion**, or **rejection by the safety policy**
 * (status: FAILURE), and that information was being dropped by humanize. Always surface
 * status / failure_reason / task_id, and return failures as failures (never let them look like success).
 */
async function generationSaveReport({ tool, built, data, log }) {
  if (!built?.saveTo) return null;
  if (existsSync(built.saveTo)) return { note: describeSavedFile(built.saveTo), ok: true };

  const url = firstMediaUrl(data);
  if (url.length > 0) {
    if (SAVABLE_URL_RE.test(url)) {
      const saved = await downloadTo(built.saveTo, url, log, tool);
      if (saved) return { note: describeSavedFile(built.saveTo), ok: true };
    }
    return { note: `Could not save the file. Fetch it from this URL: ${url}`, ok: true };
  }

  const item = firstGenerationItem(data) ?? {};
  const status = pickString(item, ['status', 'state']);
  const reason = pickString(item, ['failure_reason', 'error_code', 'status_tip', 'progress_tip', 'message']);
  const taskId = pickString(item, ['task_id', 'id']);
  const lines = ['⚠ A generation result came back, but **no file was saved** (and there is no URL either).'];
  if (status.length > 0) lines.push(`status: ${status}`);
  if (reason.length > 0) lines.push(`reason: ${reason}`);
  if (taskId.length > 0) lines.push(`task_id: ${taskId}`);
  const explain = explainGenerationFailure(status, reason);
  lines.push(
    explain.length > 0
      ? explain
      : 'Either the CLI returned without waiting for the generation to finish, or the server rejected the generation.',
  );
  lines.push(
    'Running the same command again starts a **new generation** (and spends credits). ' +
      'Try different wording, or check the result on the Genspark screen (history).',
  );
  return { note: lines.join('\n'), ok: false };
}

/** Map a run result onto the command return value (CommandResult). */
async function reportRun(tool, result, built, cfg, log) {
  const described = describeRun(result, { tool, maxChars: Number(cfg.maxOutputChars ?? 100000) });
  if (cfg.debug && typeof result.stderr === 'string' && result.stderr.trim().length > 0) {
    log?.(`[genspark] ${tool} stderr: ${result.stderr.trim().slice(0, 500)}`);
  }
  if (!described.ok) return { kind: 'error', text: described.text };
  const { value } = parseEnvelope(result.stdout);
  const human = TEXTUAL_TOOLS.has(tool) ? null : humanizeData(value?.data);
  let text = human ?? described.text;
  const save = await generationSaveReport({ tool, built, data: value?.data, log });
  if (save !== null) text += `\n${save.note}`;
  const kind = save !== null && !save.ok ? 'error' : 'success';
  return { kind, text: `${text}\n(tool: ${tool})` };
}

/** Auto-save path for generated media (<cwd>/genspark-out/<timestamp>-<kind>[-<slug>].<ext>). */
export function autoSavePath(cwd, kind, input, extension) {
  const dir = join(cwd, 'genspark-out');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* If it cannot be created, it surfaces as a CLI-side save error */
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return join(dir, `${stamp}-${kind}${slug.length > 0 ? `-${slug}` : ''}.${extension}`);
}

/**
 * Interpret the first token as url and the rest as question (a default question is used when omitted).
 * If files are attached, target the first one and treat the whole input as the question.
 */
function splitUrlAndQuestion(input, files = []) {
  const text = String(input ?? '').trim();
  const question = text.length > 0 ? text : 'Summarize the key points of this document concisely.';
  if (files.length > 0) return { url: files[0], question };
  const match = /^(\S+)\s*([\s\S]*)$/.exec(text);
  const url = match?.[1] ?? text;
  const rawQuestion = (match?.[2] ?? '').trim();
  return { url, question: rawQuestion.length > 0 ? rawQuestion : 'Summarize the key points of this document concisely.' };
}

/**
 * Interpret the first token as a media path and the rest as the instruction (describes the content when omitted).
 * If files are attached, target them and treat the whole input as the instruction.
 */
function splitMediaAndInstruction(input, files = []) {
  const text = String(input ?? '').trim();
  const instruction = text.length > 0 ? text : 'Describe the contents of this media in detail.';
  if (files.length > 0) return { media_list: files, instruction };
  const match = /^(\S+)\s*([\s\S]*)$/.exec(text);
  const media = match?.[1] ?? text;
  const rawInstruction = (match?.[2] ?? '').trim();
  return {
    media,
    instruction: rawInstruction.length > 0 ? rawInstruction : 'Describe the contents of this media in detail.',
  };
}

// ── Receiving attachments (composer images / files) ──────────────────────────
//
// The host's dsh-commands rejects runs with attachments **before the handler starts**
// unless the command declares `input.attachments = true` (`<name> does not accept attachments`).
// For declaring commands, `invocation.attachments` carries
//   { type: 'image', attachment: ImageAttachmentRef } / { type: 'file', attachment: FileAttachmentRef }
// in selection order. Here we resolve them to **local paths gsk can read**.
// gsk is a child process, so passing the host-side actual path makes it upload automatically
// (the plugin itself never reads the file, so the sandbox does not affect it).

/** Image mediaType → extension (used only when no path can be obtained at all). */
const EXT_BY_MEDIA_TYPE = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
};

function commandCtx(invocation) {
  try {
    return invocation?.agent?.ctx;
  } catch {
    return undefined;
  }
}

function getService(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/** Get the host-side actual path from an attachment block reference (several APIs are tried because implementations differ). */
function hostPathOf(store, block) {
  const ref = block?.attachment;
  if (ref === undefined || ref === null) return undefined;
  const call = (name) => {
    try {
      const fn = store?.[name];
      return typeof fn === 'function' ? fn.call(store, ref) : undefined;
    } catch {
      return undefined;
    }
  };
  const preferred = block.type === 'image' ? ['imageHostPath', 'fileHostPath'] : ['fileHostPath', 'imageHostPath'];
  for (const name of preferred) {
    const value = call(name);
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Read the attachment bytes (fallback for backends where a path is unavailable). */
async function readAttachmentBytes(store, block) {
  const ref = block?.attachment;
  if (typeof store?.readImage === 'function' && block?.type === 'image') {
    try {
      const stored = await store.readImage(ref);
      const data = stored?.data ?? stored?.bytes;
      if (data !== undefined && data !== null) return Buffer.from(data);
    } catch {
      /* try the next approach */
    }
  }
  if (typeof store?.readFileStream === 'function') {
    try {
      const chunks = [];
      for await (const chunk of store.readFileStream(ref)) chunks.push(Buffer.from(chunk));
      if (chunks.length > 0) return Buffer.concat(chunks);
    } catch {
      /* try the next approach */
    }
  }
  return undefined;
}

/** Extension to give the attachment (name → mediaType → empty). */
function extensionOf(block) {
  const mediaType = block?.attachment?.mediaType;
  if (typeof mediaType === 'string' && EXT_BY_MEDIA_TYPE[mediaType] !== undefined) return EXT_BY_MEDIA_TYPE[mediaType];
  const name = block?.attachment?.name;
  if (typeof name === 'string') {
    const ext = extname(name);
    if (ext.length > 0) return ext;
  }
  return '';
}

/**
 * Resolve invocation.attachments into an array of local paths gsk can use.
 * Empty array when there are no attachments. Throws when resolution fails (the CLI is not started).
 */
export async function resolveAttachmentFiles(invocation, deps) {
  const list = Array.isArray(invocation?.attachments) ? invocation.attachments : [];
  if (list.length === 0) return [];
  // Prefer the plugin's ctx (injected by index.js); fall back to the agent-side ctx
  let store;
  for (const candidate of [deps?.ctx, commandCtx(invocation)]) {
    store = getService(candidate, 'attachments');
    if (store !== undefined) break;
  }
  if (store === undefined) {
    throw new Error(
      'Cannot read the attachment (this profile has no attachments service). ' +
        'Switch to typing the file path as text instead.',
    );
  }
  const cwd = commandCwd(invocation);
  const files = [];
  for (const [index, block] of list.entries()) {
    const hostPath = hostPathOf(store, block);
    if (hostPath !== undefined) {
      // Images in the real store come back as extension-less content-addressed paths (<root>/objects/xx/<sha256>).
      // gsk decides the kind from the extension, so only extension-less files are copied to genspark-out/attachments.
      if (extname(hostPath).length > 0) {
        files.push(hostPath);
        continue;
      }
      const ext = extensionOf(block);
      if (ext.length === 0) {
        files.push(hostPath);
        continue;
      }
      const dir = join(cwd, 'genspark-out', 'attachments');
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        /* surfaces during the copy */
      }
      const target = join(dir, `${basename(hostPath).slice(0, 16)}-${index}${ext}`);
      copyFileSync(hostPath, target);
      files.push(target);
      continue;
    }
    const bytes = await readAttachmentBytes(store, block);
    if (bytes === undefined) {
      throw new Error(
        'Could not obtain the attachment contents (the host returned neither a path nor bytes). ' +
          'Please type the file path as text.',
      );
    }
    const dir = join(cwd, 'genspark-out', 'attachments');
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* surfaces during the write */
    }
    const target = join(dir, `${Date.now()}-${index}${extensionOf(block)}`);
    writeFileSync(target, bytes);
    files.push(target);
  }
  return files;
}

/**
 * Command definitions corresponding to promoted tools, one per tool (genspark-* → gsk tool).
 * hint is the input-field hint; toArgs converts the input string into Genspark arguments.
 */
const PROMOTED_COMMANDS = [
  {
    name: 'genspark-search',
    gsk: 'web_search',
    hint: 'Search query (e.g. latest DeepSeek Harness news)',
    description: 'Run a web search and show the results (uses no conversation history)',
    toArgs: (input) => ({ q: input }),
  },
  {
    name: 'genspark-image-search',
    gsk: 'image_search',
    hint: 'Image search terms (English works best)',
    description: 'Search for images and list their URLs',
    toArgs: (input) => ({ query: input }),
  },
  {
    name: 'genspark-crawl',
    gsk: 'crawler',
    hint: '<URL or local file path>',
    description: 'Fetch the body of a web page / PDF',
    attachments: true,
    toArgs: (input, _cwd, files) => ({ url: files.length > 0 ? files[0] : input }),
  },
  {
    name: 'genspark-scholar',
    gsk: 'scholar_search',
    hint: 'Paper search terms (e.g. diffusion model for speech synthesis)',
    description: 'Search academic papers (title, authors, citation count)',
    toArgs: (input) => ({ query: input }),
  },
  {
    name: 'genspark-maps',
    gsk: 'maps_search',
    hint: 'Place question (e.g. cafes around Tokyo Station)',
    description: 'Search maps and places (for directions, use genspark_run maps_search with engine=maps_directions)',
    toArgs: (input) => ({ query_type: 'search', engine: 'maps', query: input }),
  },
  {
    name: 'genspark-summarize',
    gsk: 'summarize_large_document',
    hint: '<URL or local path> [question] (attachments allowed; omit the question to summarize the key points)',
    description: 'Feed a long document to the model and answer questions about it (PDF / Office / web page)',
    attachments: true,
    toArgs: (input, _cwd, files) => splitUrlAndQuestion(input, files),
  },
  {
    name: 'genspark-image',
    gsk: 'image_generation',
    hint: 'Description of the image to generate (English recommended; attach an image to edit or restyle it)',
    description: 'Generate an image and save it to genspark-out/ (spends credits)',
    attachments: true,
    toArgs: (input, cwd, files) => ({
      query: input.length > 0 ? input : undefined,
      image_urls: files.length > 0 ? files : undefined,
      save_to: autoSavePath(cwd, 'image', input, 'png'),
    }),
  },
  {
    name: 'genspark-video',
    gsk: 'video_generation',
    hint: 'Description of the video to generate (English; an attached image can be used as the first frame)',
    description: 'Generate a video and save it (spends credits, takes a few minutes, silent by default)',
    attachments: true,
    toArgs: (input, cwd, files) => ({
      query: input.length > 0 ? input : 'Animate the reference image with subtle, natural motion.',
      model: 'kling/v3',
      image_urls: files.length > 0 ? files : undefined,
      save_to: autoSavePath(cwd, 'video', input, 'mp4'),
    }),
  },
  {
    name: 'genspark-audio',
    gsk: 'audio_generation',
    hint: 'Script to read aloud, or a description of the sound to generate',
    description: 'Generate audio (speech, sound effects, music) and save it (spends credits)',
    toArgs: (input, cwd) => ({ prompt: input, save_to: autoSavePath(cwd, 'audio', input, 'mp3') }),
  },
  {
    name: 'genspark-analyze-media',
    gsk: 'understand_images',
    hint: '<path or URL of an image/video/audio> [instruction] (attachments allowed; describes the content when omitted)',
    description: 'Understand and describe media (images, video, audio) using the default general-purpose model',
    attachments: true,
    toArgs: (input, _cwd, files) => splitMediaAndInstruction(input, files),
  },
];

/**
 * Social search commands (an "AI router" that picks the service and action).
 *
 * The command itself calls no API (spends no credits). The text it accepts is passed on as-is
 * as a request to the model, and the model decides whether to use genspark_x_search /
 * genspark_instagram_search / genspark_reddit_search (`promptFor` builds that follow-up text).
 * Result formatting (default 25 items, with URLs) is done by each tool.
 */
const SOCIAL_COMMANDS = [
  {
    name: 'genspark-social',
    platforms: ['x', 'instagram', 'reddit'],
    hint: 'What to look up (e.g. Genspark reputation / recent posts by @elonmusk / r/programming topics)',
    description: 'The AI picks X, Instagram, or Reddit and searches (results arrive in chat)',
  },
  {
    name: 'genspark-x',
    platforms: ['x'],
    hint: 'What to look up (e.g. DeepSeek Harness reputation / @elonmusk)',
    description: 'Search X (Twitter): posts, users, and profiles',
  },
  {
    name: 'genspark-instagram',
    platforms: ['instagram'],
    hint: 'What to look up (e.g. travel photos / @natgeo)',
    description: 'Search Instagram: posts, users, and profiles',
  },
  {
    name: 'genspark-reddit',
    platforms: ['reddit'],
    hint: 'What to look up (e.g. local LLM reputation)',
    description: 'Search Reddit: posts, comments, and subreddits',
  },
];

/** Human-readable labels for the services a command targets ("X / Instagram / Reddit"). */
function platformLabels(platforms) {
  return platforms.map((key) => SOCIAL_PLATFORMS[key]?.label ?? key).join(' / ');
}

/**
 * Routing prompt handed to the model.
 *
 * Let the model decide "which service to search with which action" (do not hard-code it in the command).
 * Specify only the tool names and argument shapes, plus how to summarize results (key points, with URLs, fallbacks on failure).
 */
export function socialPrompt(command, invocation) {
  const input = String(invocation?.rawInput ?? '').trim();
  // Do not follow up on empty input (the command returns usage only)
  if (input.length === 0) return null;
  const platforms = Array.isArray(command?.platforms) ? command.platforms : ['x', 'instagram', 'reddit'];
  const labels = platformLabels(platforms);
  const lines = [`The user ran /${command?.name ?? 'genspark-social'} with this request: "${input}"`, ''];
  lines.push(
    platforms.length === 1
      ? `Search ${labels}.`
      : `Decide which of X, Instagram, and Reddit to search, and run only the ones you need (3 at most).`,
  );
  lines.push('');
  lines.push('Available tools (the action is auto-detected when omitted):');
  for (const platform of platforms) {
    const meta = SOCIAL_PLATFORMS[platform];
    const tool = SOCIAL_TOOL_BY_PLATFORM[platform];
    if (meta === undefined || tool === undefined) continue;
    const hints = ['topic → search_posts', 'find a user → search_users'];
    if (meta.actions.includes('get_posts_by_author')) hints.push('posts by that user → get_posts_by_author');
    if (meta.actions.includes('get_posts_by_user')) hints.push('posts by that user → get_posts_by_user');
    if (meta.actions.includes('get_subreddit_with_posts')) hints.push('posts in r/xxx → get_subreddit_with_posts');
    if (meta.actions.includes('get_post_with_comments')) hints.push('a post with its comments → get_post_with_comments');
    hints.push('get_user returns only the id / name (no bio or follower count)');
    lines.push(`- ${meta.label}: ${tool} (${hints.join(' / ')})`);
  }
  lines.push('');
  lines.push('Steps:');
  lines.push('1. Choose the target service and action from the request (an "@handle" or a person name means user lookups; a topic means a post search).');
  lines.push(`2. Call the tool (limit defaults to ${SOCIAL_DEFAULT_LIMIT} items; raise it if needed).`);
  lines.push('3. Summarize the results in the same language the user is using: key points, trends, and URLs of representative posts. Report only the numbers you actually obtained.');
  lines.push('4. If an action failed, add one line saying so with an alternative (change the action, widen the date range).');
  lines.push('');
  lines.push('Search tips (measured; safe to copy):');
  lines.push('- Narrow the query to 1–2 words. The upstream search behaves like an OR full-text search, so more words add more irrelevant rows.');
  lines.push('- For Japanese-language topics, add language="ja" on X (without it, plenty of similarly spelled foreign-language content gets mixed in; measured results differ).');
  lines.push('- A "#tag" does not narrow the search (tags are treated as part of the query).');
  lines.push('- On Reddit, specify a subreddit or narrow to one word. Without it, word matching is very loose.');
  lines.push('- Use at most 3 services. However, you may **retry up to 3 times within the same service with a different query**.');
  lines.push('- "Failed to execute … action" does not always mean unsupported; it can be a temporary failure (the tool has already retried once automatically).');
  lines.push('  If it still fails, try changing the action, then removing the date, then waiting a bit.');
  lines.push('- Comment fetching (get_comments / get_post_with_comments) is often empty in practice. Empty is not a failure, so do not dig deeper.');
  lines.push('');
  lines.push('If the typed tools are unavailable, run social_twitter / social_instagram / social_reddit through genspark_run.');
  return lines.join('\n');
}

/**
 * Handler for the social search commands.
 *
 * No API is called here; it only reports that the request was "accepted" (finishes in milliseconds and does not freeze the input field).
 * The actual search is kicked off by `withFollowup` → `scheduleFollowup` with the `promptFor` text, which opens a turn
 * where the model chooses and runs the tools.
 */
async function runSocialRoute(command, invocation, deps) {
  const input = String(invocation?.rawInput ?? '').trim();
  const labels = platformLabels(command.platforms);
  if (input.length === 0) {
    return {
      kind: 'success',
      text: `Enter what you want to look up. Example: /${command.name} recent posts from @elonmusk (target: ${labels})`,
    };
  }
  const cfg = deps.getConfig();
  if (cfg?.commandFollowup === false) {
    return {
      kind: 'error',
      text:
        'commandFollowup=false is set, so the AI routing (prompt follow-up) is unavailable. ' +
        'Enable the setting, or use genspark_x_search / genspark_instagram_search / genspark_reddit_search directly.',
    };
  }
  if (typeof invocation?.agent?.followup !== 'function') {
    return {
      kind: 'error',
      text:
        'AI follow-up (agent.followup) is unavailable in this environment, so routing commands do not work. ' +
        'Use genspark_x_search / genspark_instagram_search / genspark_reddit_search directly.',
    };
  }
  return { kind: 'success', text: `The AI will pick from ${labels} and search: "${input}"` };
}

const USAGE_TOOLS = 'Add a keyword to narrow the list (e.g. /genspark-tools slack send). Empty shows the group overview.';const USAGE_RUN =
  'Usage: /genspark-run <tool-name> [JSON arguments]\nExample: /genspark-run web_search {"q":"DeepSeek Harness"}\n' +
  'Find tool names with /genspark-tools. Operations with side effects cannot be run here (use the genspark_run tool).';

/** Usage text for the command list. */
function usageLines(commands) {
  const lines = ['Available commands:'];
  for (const command of commands) {
    const hint = command.input?.hint ? ` ${command.input.hint}` : '';
    lines.push(`  /${command.name}${hint}`);
    lines.push(`      ${command.description}`);
  }
  return lines;
}

/** /genspark — connection status, account, remaining credits, tool count. */
async function runStatus(invocation, deps, getCommands) {
  const cfg = deps.getConfig();
  const cwd = commandCwd(invocation);
  const signal = invocation?.signal;
  const lines = [];

  const entry = deps.runner.resolveEntry();
  if (entry === null) return { kind: 'error', text: ENTRY_NOT_FOUND_MESSAGE };
  lines.push(`CLI entry: ${entry}`);
  try {
    const runtime = deps.runner.resolveRuntime?.();
    if (runtime) lines.push(`Runtime: ${runtime.path} (${runtime.source})`);
  } catch {
    /* keep showing status even if runtime resolution fails */
  }

  const timeoutMs = Number(cfg.timeoutMs ?? 600000);
  let me = null;
  try {
    me = await deps.runner.runTool('me', {}, {
      cwd,
      signal,
      timeoutMs,
      globalArgs: ['--output', 'json', '--no-input'],
    });
  } catch (error) {
    lines.push(`Account: could not be retrieved (${error?.message ?? String(error)})`);
  }
  if (me !== null) {
    const { value } = parseEnvelope(me.stdout);
    if (value?.status === 'ok') {
      const data = value.data ?? {};
      const name = typeof data.name === 'string' && data.name.length > 0 ? ` (${data.name})` : '';
      lines.push(`Account: ${data.email ?? '(unknown)'}${name} / plan ${data.plan ?? 'unknown'}`);
      if (data.credit_balance !== undefined) lines.push(`Remaining credits: ${data.credit_balance}`);
    } else {
      const described = describeRun(me, { tool: 'me' });
      lines.push(`Account: could not be retrieved — ${described.text.split('\n')[0]}`);
    }
  }

  try {
    const catalog = await deps.catalog.load(deps.runner, { cwd, signal });
    lines.push(`Tools: ${catalog.tools.length} items`);
  } catch (error) {
    lines.push(`Tools: could not load the catalog (${String(error?.message ?? error).split('\n')[0]})`);
  }

  lines.push(`Promoted tools: ${promotedSummary(cfg.promotedCategories)}`);
  lines.push(`writeMode: ${cfg.writeMode}`);
  lines.push('');
  lines.push(...usageLines(getCommands()));
  return { kind: 'success', text: lines.join('\n') };
}

/** /genspark-tools — catalog search (shows the full argument schema when narrowed to one tool). */
async function runTools(invocation, deps) {
  const cwd = commandCwd(invocation);
  const raw = String(invocation?.rawInput ?? '').trim();
  const refresh = /^--refresh\b/.test(raw);
  const keyword = refresh ? raw.replace(/^--refresh\b/, '').trim() : raw;

  let catalog;
  try {
    catalog = await deps.catalog.load(deps.runner, { cwd, signal: invocation?.signal, refresh });
  } catch (error) {
    return { kind: 'error', text: `Could not load the catalog: ${String(error?.message ?? error)}` };
  }

  if (keyword.length > 0) {
    const tools = catalog.tools ?? [];
    // If a name or alias matches exactly, narrow to that single tool first (/genspark-tools crawler, etc.)
    const wanted = keyword.toLowerCase();
    const exact = tools.find(
      (tool) =>
        String(tool.name ?? '').toLowerCase() === wanted ||
        (tool.cli?.aliases ?? []).some((alias) => String(alias).toLowerCase() === wanted),
    );
    const matched = exact ? [exact] : filterTools(tools, { keyword });
    if (matched.length === 1) {
      const tool = matched[0];
      return {
        kind: 'success',
        text:
          `${describeToolFull(tool)}\n\n` +
          `Example: /genspark-run ${tool.name} {"<argument-name>":"<value>"}\n` +
          `(To have the model run it, use the genspark_run tool.)`,
      };
    }
  }
  return { kind: 'success', text: summarizeCatalog(catalog, { keyword, limit: 30 }) };
}

/** /genspark-models — list of generation models (reads the catalog's real enums as-is). */
async function runModels(invocation, deps) {
  const cwd = commandCwd(invocation);
  const raw = String(invocation?.rawInput ?? '').trim();
  const kind = kindOfInput(raw);

  let catalog;
  try {
    catalog = await deps.catalog.load(deps.runner, { cwd, signal: invocation?.signal });
  } catch (error) {
    const message = String(error?.message ?? error);
    return { kind: 'error', text: `Could not load the model list: ${message}` };
  }

  const entries = collectModels(catalog);
  if (entries.length === 0) {
    return { kind: 'error', text: 'Could not load the model list from the catalog (check the arguments with /genspark-tools image_generation).' };
  }
  // Without a kind, treat the rest as a partial match on the id (e.g. /genspark-models kling)
  const filter = kind === undefined ? raw : undefined;
  return { kind: 'success', text: formatModelList(entries, { kind, filter }) };
}

/** /genspark-run — run an arbitrary tool (read-only). */
async function runGeneric(invocation, deps) {
  const cfg = deps.getConfig();
  const cwd = commandCwd(invocation);
  const raw = String(invocation?.rawInput ?? '').trim();
  if (raw.length === 0) return { kind: 'error', text: USAGE_RUN };

  const match = /^(\S+)\s*([\s\S]*)$/.exec(raw);
  const toolName = match?.[1] ?? raw;
  const jsonText = (match?.[2] ?? '').trim();

  let args = {};
  if (jsonText.length > 0) {
    try {
      args = JSON.parse(jsonText);
    } catch (error) {
      return {
        kind: 'error',
        text: `Could not parse the JSON arguments: ${error?.message ?? String(error)}\n${USAGE_RUN}`,
      };
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return { kind: 'error', text: `Specify the arguments as a JSON object.\n${USAGE_RUN}` };
    }
  }

  // Pre-check only when the catalog is available (otherwise leave the decision to the CLI)
  try {
    const catalog = await deps.catalog.load(deps.runner, { cwd, signal: invocation?.signal });
    const tool = (catalog.tools ?? []).find(
      (entry) => entry.name === toolName || (entry.cli?.aliases ?? []).includes(toolName),
    );
    if (tool === undefined) {
      // Pass only read-only CLI built-in commands (not listed in the catalog).
      // Anything else is likely a typo, so explain instead of running it (avoid built-in write commands).
      if (!CLI_BUILTIN_READONLY.has(toolName)) {
        return {
          kind: 'error',
          text:
            `Genspark has no tool named "${toolName}". Search with /genspark-tools <keyword>.\n` +
            `(CLI built-in read-only commands ${[...CLI_BUILTIN_READONLY].join(' / ')} can be run.)`,
        };
      }
    }
    if (tool.cli?.interactive_only) {
      return { kind: 'error', text: `"${tool.name}" requires interactive input, so it cannot be run from a plugin.` };
    }
    if (tool.cli?.requires_confirmation) {
      return {
        kind: 'error',
        text:
          `"${tool.name}" requires confirmation. Commands have no approval mechanism, so it will not be run.\n` +
          'Ask the model to run it through the genspark_run tool (approve_write: true).',
      };
    }
  } catch {
    /* ignore a missing catalog and run anyway */
  }

  const timeoutMs = Number(cfg.timeoutMs ?? 600000);
  let result;
  try {
    result = await deps.runner.runTool(toolName, args, {
      cwd,
      signal: invocation?.signal,
      timeoutMs,
      globalArgs: ['--output', 'json', '--timeout', String(timeoutMs), '--no-input'],
    });
  } catch (error) {
    if (error?.code === 'GSK_ENTRY_NOT_FOUND') return { kind: 'error', text: error.message };
    return { kind: 'error', text: `Run failed: ${error?.message ?? String(error)}` };
  }
  return await reportRun(toolName, result, null, cfg, deps.log);
}

/** Generation examples shown in guard guidance (per kind). */
const EXAMPLE_BY_KIND = {
  image: 'Mount Fuji at sunset',
  video: 'cherry blossom petals drifting for 5 seconds',
  audio: 'Good morning',
};

/** Labels used for generation kinds in model-list headings and guidance. */
const MODEL_LABEL_BY_KIND = {
  image: 'image',
  video: 'video',
  audio: 'audio',
};

/** Guidance for `/command usage` (does not run a generation). */
function usageTextFor(command, gsk) {
  const kind = modelKindOfTool(gsk);
  const example = EXAMPLE_BY_KIND[kind] ?? '…';
  return [
    `/${command.name} usage`,
    `  /${command.name} ${command.hint}`,
    '',
    `Example: /${command.name} ${example}`,
    '',
    'No credits were spent (nothing was generated).',
    'To see available models, use `/genspark-models <kind>`, or ask the AI "which video models are available?"',
  ].join('\n');
}

/**
 * Response when a generation command receives a "model list" or "usage" request (nothing is generated).
 *
 * Input is passed straight to the generation prompt by design, so without this guard
 * `/genspark-video video model list` would be billed as a video generation (it actually misfired in testing).
 */
async function metaIntentResult({ command, gsk, intent, deps, cwd, invocation }) {
  if (intent.kind === 'usage') {
    return { kind: 'success', text: usageTextFor(command, gsk) };
  }

  const kind = modelKindOfTool(gsk);
  const label = MODEL_LABEL_BY_KIND[kind] ?? 'generation';
  const example = EXAMPLE_BY_KIND[kind] ?? '…';
  const head = [
    'Nothing was generated (no credits were spent).',
    `This was read as a request for the ${label} model list, so the list is returned instead of a generation.`,
    '',
  ];

  try {
    const catalog = await deps.catalog.load(deps.runner, { cwd, signal: invocation?.signal });
    const entries = collectModels(catalog);
    return {
      kind: 'success',
      text: [
        ...head,
        formatModelList(entries, { kind }),
        '',
        `To generate, use /${command.name} <what you want to create> (e.g. /${command.name} ${example}).`,
      ].join('\n'),
    };
  } catch (error) {
    return {
      kind: 'success',
      text: [
        ...head,
        `Could not load the model list: ${error?.message ?? error}`,
        `Retry with /genspark-models ${label}, or ask the AI "which ${label} models are available?"`,
      ].join('\n'),
    };
  }
}

/** Build the command handler for one promoted tool. */
function makePromotedHandler(command, spec, deps) {
  return async (invocation) => {
    const cfg = deps.getConfig();
    const cwd = commandCwd(invocation);
    const input = String(invocation?.rawInput ?? '').trim();

    // Resolve attachments (images, files) to local paths gsk can read. If that fails, the CLI is not started.
    let files;
    try {
      files = command.attachments === true ? await resolveAttachmentFiles(invocation, deps) : [];
    } catch (error) {
      return { kind: 'error', text: `${error?.message ?? error}` };
    }

    if (input.length === 0 && files.length === 0) {
      return { kind: 'error', text: `Input is required. Usage: /${command.name} ${command.hint}` };
    }

    // Generation commands must not generate when asked for a "model list" or "usage" (prevents accidental credit spend).
    // When attachments are present the target is clear, so no guard is applied.
    if (files.length === 0 && isGenerationTool(spec.gsk)) {
      const intent = detectMetaIntent(input);
      if (intent !== undefined) {
        return metaIntentResult({ command, gsk: spec.gsk, intent, deps, cwd, invocation });
      }
    }

    let args;
    try {
      args = command.toArgs(input, cwd, files);
    } catch (error) {
      return { kind: 'error', text: `${error?.message ?? error}` };
    }

    let built;
    try {
      built = spec.build(args, cwd);
    } catch (error) {
      return { kind: 'error', text: `${error?.message ?? error}` };
    }

    const gsk = typeof built.gsk === 'string' && built.gsk.length > 0 ? built.gsk : spec.gsk;
    // As with promoted tools, video and similar have a minimum longer than the configured value
    const timeoutMs = Math.max(Number(cfg.timeoutMs ?? 600000), Number(spec.timeoutMs ?? 0));
    let result;
    try {
      result = await deps.runner.runTool(gsk, built.args, {
        cwd,
        signal: invocation?.signal,
        timeoutMs,
        globalArgs: ['--output', 'json', '--timeout', String(timeoutMs), '--no-input'],
        toolArgs: built.options ?? [],
      });
    } catch (error) {
      if (error?.code === 'GSK_ENTRY_NOT_FOUND') return { kind: 'error', text: error.message };
      return { kind: 'error', text: `Run failed: ${error?.message ?? String(error)}` };
    }
    return await reportRun(gsk, result, built, cfg, deps.log);
  };
}

/**
 * Instruction text for handing the command result to the model.
 * The raw result is already shown in the command area, so do not make the model repeat it.
 */
const FOLLOWUP_INSTRUCTION = [
  'The raw output is already shown in the command area. Do not repeat it; briefly state the key points and what they mean.',
  'Answer in the same language the user is using.',
  'Keep only the URLs and saved paths that are needed.',
  'For errors, briefly explain the cause and the next step.',
].join('\n');

/**
 * Hand the command result to the agent's next turn (`agent.followup`).
 *
 * Host commands by design do not create model messages (the UI renders result text outside the model history).
 * So without this, all the chat gets is "a pile of search results", and the AI cannot interpret them.
 * The `dsh-agent` Agent has `followup` (queues a next-turn user message and wakes the driver), so
 * this lets the model read the result and answer with the key points in chat.
 * `dsh-commands` also states that "the command runner can explicitly schedule agent work (token usage is the same as normal input)"
 * — a supported use.
 *
 * If the host has no `followup`, do nothing (do not break registration or execution).
 *
 * Important: do not make handler completion (`command/done`, recorded by the host) wait on the follow-up.
 * On real hardware we observed a state where "the command never completes and neither the result nor the AI reply appears",
 * so to guarantee the command always completes even if the `followup` implementation is slow, never returns, or is rejected,
 * the call is deferred to the next tick and the returned Promise is caught and swallowed (never awaited).
 *
 * The `source` of the message sent must pass session format V4 validation.
 * `{ kind: 'plugin', plugin: '…' }` is a deprecated V3 wrapper and
 * is rejected with "format v4 message requires a producer-owned source kind" (observed on real hardware).
 * The canonical form is `{ kind: 'plugin:<plugin-name>' }`. tests/preflight-message-source.mjs pins this with the real validator.
 *
 * The message itself is passed as a complete `UserMessage` (`id` / `role` / `content` / `source`).
 * If any field is missing the save succeeds, but on reload
 * "session event at seq N lacks an identified message" makes the session unopenable (observed 2026-10-18 on real hardware).
 */
function scheduleFollowup(command, invocation, result, deps) {
  const cfg = deps.getConfig();
  if (cfg.commandFollowup === false) return;
  const agent = invocation?.agent;
  if (!agent || typeof agent.followup !== 'function') return;

  const input = String(invocation?.rawInput ?? '').trim();
  const text = typeof result?.text === 'string' ? result.text : '';
  // Routing commands (/genspark-social, etc.) pass the "request", not the "run result", to the model.
  // When promptFor builds the text, the default text below is not used.
  let prompt;
  if (typeof command.promptFor === 'function') {
    try {
      prompt = command.promptFor(invocation);
    } catch (error) {
      deps.log?.(`[genspark] failed to build the follow-up text for /${command.name}: ${error?.message ?? error}`);
    }
    // null explicitly means "do not follow up for this run"
    if (prompt === null) return;
  }
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    prompt = [
      `Genspark command result for /${command.name}${input.length > 0 ? ` ${input}` : ''}.`,
      `Status: ${result?.kind === 'success' ? 'success' : 'error'}`,
      '',
      text,
      '',
      FOLLOWUP_INSTRUCTION,
    ].join('\n');
  }

  const fail = (error) => {
    deps.log?.(`[genspark] failed to hand off the command result (/${command.name}): ${error?.message ?? error}`);
  };

  const timer = setTimeout(() => {
    try {
      const message = {
        // V4 user/message requires `id` and `role` (dsh-session's assertMessageEventShape).
        // If followup is called with them missing, the save itself succeeds, but the next time the session is opened
        // it fails with "session event at seq N lacks an identified message" (observed on real hardware).
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        // Session format V4 rejects `kind: 'plugin'` (the deprecated V3 wrapper).
        // The canonical plugin producer kind is `plugin:<plugin-name>`
        // (dsh-session-format-v3-to-v4's producerKind() returns `plugin:${plugin}`).
        source: { kind: 'plugin:dsh-genspark' },
      };
      const returned = agent.followup(message);
      if (returned && typeof returned.then === 'function') returned.then(undefined, fail);
    } catch (error) {
      fail(error);
    }
  }, 0);
  // Keep the timer from holding the process open
  timer?.unref?.();
}

/**
 * Is this a session where no turn has started yet (i.e. a new conversation)?
 *
 * DSH shows the hero screen for a "blank" session, covering the chat area (including the command area).
 * blank is only cleared by `turn/start`, so even after running a command nothing is visible
 * until generation finishes and the follow-up turn starts (observed 2026-10-18 on real hardware).
 * If the log has at least one `turn/start`, treat it as an existing conversation.
 */
function isFreshSession(invocation) {
  try {
    const session = invocation?.agent?.session;
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined;
    if (!Array.isArray(events)) return false;
    return !events.some((event) => event?.type === 'turn/start');
  } catch {
    return false;
  }
}

/**
 * Receipt-message follow-up (new conversations only).
 *
 * Sending one followup as soon as the command is accepted starts that turn, which clears the hero screen,
 * so the command area's "Sending to Genspark…" and the short reply become visible right there.
 * In an existing conversation the command area is already visible, so do nothing (avoid an extra turn / tokens).
 */
function scheduleReceipt(command, invocation, deps, text) {
  const cfg = deps.getConfig();
  if (cfg?.commandFollowup === false) return;
  const agent = invocation?.agent;
  if (!agent || typeof agent.followup !== 'function') return;
  if (!isFreshSession(invocation)) return;

  const input = String(invocation?.rawInput ?? '').trim();
  const prompt = [
    `Genspark command /${command.name}${input.length > 0 ? ` ${input}` : ''} was accepted.`,
    'Sending continues in the background; the result will arrive in a separate message.',
    `Reply to the user with exactly this one sentence, verbatim (no preamble or additions): "${text}"`,
  ].join('\n');

  const fail = (error) => {
    deps.log?.(`[genspark] failed to send the receipt message (/${command.name}): ${error?.message ?? error}`);
  };
  const timer = setTimeout(() => {
    try {
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin:dsh-genspark' },
      };
      const returned = agent.followup(message);
      if (returned && typeof returned.then === 'function') returned.then(undefined, fail);
    } catch (error) {
      fail(error);
    }
  }, 0);
  timer?.unref?.();
}

/**
 * Default upper bound for waiting on a command handler to finish (milliseconds).
 *
 * The host composer stays in the sending transaction until `command/done` arrives (phase = submitting),
 * and during that time the input field is not editable and the draft is retained
 * (dsh-client-ui-conversation/lib/client.js:17292 `machineBusy` and :17295 `editable`.
 * In testing, an image-generation command took 8 seconds and the input field stayed frozen the whole time).
 * Return the handler after a fixed time to complete the command, and deliver the result via `followup` (chat).
 * Can be changed with the `commandInlineWaitMs` setting; 0 or below waits until completion as before.
 */
const INLINE_WAIT_DEFAULT_MS = 2500;

/** Text shown in the command area on an early return (the result arrives in chat afterwards). */
const INLINE_WAIT_TEXT =
  'Genspark is running this now. The result will arrive in chat afterwards (the command area completes early to keep the wait short).';

/**
 * Wait estimates per generation kind (measured 2026-10-18, default models).
 * Images take 5–10 s, videos (5 s, 720p) about 50 s, and even a status check takes a few seconds to start the CLI.
 * Without an estimate users think it has stalled, so include it in the command area's completion text.
 */
const INLINE_WAIT_TEXT_BY_TOOL = {
  image_generation: 'Generating an image (estimate: 15–40 s).',
  video_generation: 'Generating a video (estimate: 1–2 min; longer videos take more time).',
  audio_generation: 'Generating audio (estimate: 30–60 s).',
  understand_images: 'Analyzing the target (estimate: 10–30 s).',
  analyze_media: 'Analyzing the target (estimate: 10–30 s).',
  audio_transcribe: 'Transcribing (estimate: 10–30 s).',
};

/**
 * Commands that take a long time — they **return a receipt message right after input**.
 * They wait only 150ms for validation errors and, if still not finished, return
 * "Sending to Genspark" and deliver the result in chat (followup).
 * Commands that finish in seconds (lists, status checks) still return their result in place.
 */
const ACK_TOOLS = new Set([
  'image_generation',
  'video_generation',
  'audio_generation',
  'understand_images',
  'analyze_media',
  'audio_transcribe',
  'summarize_large_document',
  'crawler',
]);

/** Estimates appended to the receipt message (for ACK_TOOLS). */
const ACK_HINT_BY_TOOL = {
  image_generation: ' (estimate: 15–40 s)',
  video_generation: ' (estimate: 1–2 min; longer videos take more time)',
  audio_generation: ' (estimate: 30–60 s)',
  understand_images: ' (analysis estimate: 10–30 s)',
  analyze_media: ' (analysis estimate: 10–30 s)',
  audio_transcribe: ' (transcription estimate: 10–30 s)',
  summarize_large_document: ' (estimate: 10–60 s)',
  crawler: ' (estimate: 10–30 s)',
};

/** Wait before returning the receipt message (catches validation errors only; far shorter than a CLI start). */
const ACK_WAIT_MS = 150;

/** Early-return text. The receipt (ack) and running states are worded differently. */
function inlineWaitText(command, ack) {
  if (ack) {
    const hint = ACK_HINT_BY_TOOL[command?.gsk] ?? '';
    return `Sending to Genspark${hint}. The result will arrive in chat afterwards.`;
  }
  const lead = command?.gsk === undefined ? undefined : INLINE_WAIT_TEXT_BY_TOOL[command.gsk];
  return lead === undefined
    ? INLINE_WAIT_TEXT
    : `${lead}The result will arrive in chat afterwards (the command area completes first).`;
}

/** Normalize an invalid return value into an error result (never throws). */
function normalizeOutcome(command, value, deps) {
  if (value !== null && typeof value === 'object' && (value.kind === 'success' || value.kind === 'error')) return value;
  deps.log?.(`[genspark] /${command.name} returned an invalid result: ${JSON.stringify(value)?.slice(0, 200)}`);
  return { kind: 'error', text: `Could not interpret the result of /${command.name} (this may be a plugin bug).` };
}

/** Normalize an exception into an error result (never throws). */
function outcomeFromError(command, error, deps) {
  const detail = error?.stack ?? error?.message ?? String(error);
  deps.log?.(`[genspark] an exception occurred while running /${command.name}: ${detail}`);
  return {
    kind: 'error',
    text: [
      `An unexpected error occurred while running /${command.name}: ${error?.message ?? String(error)}`,
      command.gsk === undefined
        ? 'Try again, or check the connection status with /genspark (details are in the DSH logs).'
        : `The argument shape can be checked with /genspark-tools ${command.gsk} (details are in the DSH logs).`,
    ].join('\n'),
  };
}

/**
 * Resolve the wait time before an early return.
 *
 * - `ms` is 0: no early return (wait for completion as before)
 * - `ack` is true: mode that returns the receipt message right after input ("Sending to Genspark")
 *
 * `ACK_TOOLS` (generation / analysis) return the receipt message in **at most 150ms**, regardless of `commandInlineWaitMs`.
 * That setting defaults to 2500ms and is also specified explicitly in cordis.patch.yml, so honoring it would delay the receipt
 * by 2.5 seconds and lose the "return right after input" intent (the 0.1.7 regression).
 * Only when set to 0 or below do we wait until completion as before (for when you want the result in the command area).
 *
 * If there is no way to deliver the result (`agent.followup` and commandFollowup), there is no early return.
 * Returning without waiting would make the result disappear with nowhere to show it.
 */
function inlineWait(invocation, deps, command) {
  if (typeof invocation?.agent?.followup !== 'function') return { ms: 0, ack: false };
  let cfg = {};
  try {
    cfg = deps.getConfig?.() ?? {};
  } catch {
    cfg = {};
  }
  if (cfg?.commandFollowup === false) return { ms: 0, ack: false };
  const raw = cfg?.commandInlineWaitMs;
  const parsed = raw === undefined || raw === null || raw === '' ? undefined : Number(raw);
  const waitMs = parsed === undefined || !Number.isFinite(parsed) ? INLINE_WAIT_DEFAULT_MS : parsed;
  if (!(waitMs > 0)) return { ms: 0, ack: false };
  if (command !== undefined && command.gsk !== undefined && ACK_TOOLS.has(command.gsk)) {
    return { ms: Math.min(waitMs, ACK_WAIT_MS), ack: true };
  }
  return { ms: waitMs, ack: false };
}

/**
 * Wrap a command handler to (1) convert exceptions into error results, (2) hand the result to the model,
 * and (3) complete long runs early to shorten the input-field freeze.
 *
 * If we throw, the host shows the raw error message as-is, so every command returns errors
 * as normal result text and the cause goes to the log
 * (the host also records `command/done` via settleThrown, but we keep the user-facing wording consistent here).
 * The follow-up is not awaited (`scheduleFollowup` is synchronous).
 *
 * On an early return the handler keeps running, so `followup` delivers the result once it is determined
 * (the caller gets only the one line "running"). In that case **the RPC cancel signal stops being forwarded**:
 * `dsh-commands`' signal is "owned by the UI request", and an abort after the handler returns must not
 * take down the background CLI run (protect it with the CLI-side timeout).
 */
export function withFollowup(command, deps) {
  const inner = command.handler;
  return async (invocation) => {
    let finished = false;
    let finalResult;
    const settle = (result) => {
      finished = true;
      finalResult = result;
      scheduleFollowup(command, invocation, result, deps);
      return result;
    };

    const { ms: waitMs, ack } = inlineWait(invocation, deps, command);
    // In a new conversation the hero screen covers the chat area, so start a turn on receipt to clear it.
    if (ack) scheduleReceipt(command, invocation, deps, inlineWaitText(command, true));
    let forwarded = invocation;
    let detach = () => {};
    if (waitMs > 0) {
      const source = invocation?.signal;
      if (source !== undefined && source !== null && typeof source.addEventListener === 'function') {
        const controller = new AbortController();
        const forward = () => {
          try {
            controller.abort(source.reason);
          } catch {
            controller.abort();
          }
        };
        source.addEventListener('abort', forward, { once: true });
        forwarded = { ...invocation, signal: controller.signal };
        detach = () => {
          try {
            source.removeEventListener('abort', forward);
          } catch {
            /* noop */
          }
        };
      }
    }

    const pending = Promise.resolve()
      .then(() => inner(forwarded))
      .then(
        (value) => settle(normalizeOutcome(command, value, deps)),
        (error) => settle(outcomeFromError(command, error, deps)),
      );

    if (!(waitMs > 0)) return pending;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        detach();
        resolve(finished ? finalResult : { kind: 'success', text: inlineWaitText(command, ack) });
      }, waitMs);
      // Keep the timer from holding the process open
      timer?.unref?.();
      const done = (result) => {
        clearTimeout(timer);
        detach();
        resolve(result);
      };
      pending.then(done, (error) => done(settle(outcomeFromError(command, error, deps))));
    });
  };
}

/**
 * Build the command definitions to register.
 *
 * The `@deepseek-ai/dsh-commands` contract:
 *   - name matches /^[a-z][a-z0-9_-]*$/, description is a non-empty string, handler is a function.
 *   - Adding `input: { hint }` means selecting it from the menu does not run immediately but prompts for input (hint is required and non-empty).
 *   - handler returns { kind: 'success' | 'error', text }.
 *
 * @returns {Array<{name: string, description: string, input?: {hint: string}, handler: Function}>}
 */
export function buildGensparkCommands({ getConfig, runner, catalog, log, ctx } = {}) {
  // Do not stop registration or execution if loading config fails (run with defaults and log the cause)
  const config = () => {
    try {
      return (typeof getConfig === 'function' ? getConfig() : getConfig) ?? {};
    } catch (error) {
      log?.(`[genspark] failed to load the settings: ${error?.message ?? error}`);
      return {};
    }
  };
  const deps = { getConfig: config, runner, catalog, log, ctx };

  // Which commands are exposed follows the same category settings as promoted tools
  const wanted = resolvePromotedCategories(config().promotedCategories, log);
  const promoted = [];
  for (const command of PROMOTED_COMMANDS) {
    const spec = SPEC_BY_GSK.get(command.gsk);
    if (spec === undefined) continue;
    if (!wanted.has(spec.category)) continue;
    promoted.push({
      name: command.name,
      description: command.description,
      // Commands that accept attachments must declare it to the host (without it they are rejected before running with attachmentsUnsupported)
      input: command.attachments === true ? { hint: command.hint, attachments: true } : { hint: command.hint },
      gsk: command.gsk,
      handler: makePromotedHandler(command, spec, deps),
    });
  }

  let commands = [];
  const core = [
    {
      name: 'genspark',
      description: 'Show connection status, account, remaining credits, and the command list',
      handler: (invocation) => runStatus(invocation, deps, () => commands),
    },
    {
      name: 'genspark-tools',
      description: 'Search all tools and show their argument shapes (--refresh updates the cache)',
      input: { hint: USAGE_TOOLS },
      handler: (invocation) => runTools(invocation, deps),
    },
    {
      name: 'genspark-models',
      description: 'List the models available for images, video, audio, and transcription',
      input: { hint: 'image / video / audio / transcription (omit to show all; a partial id also narrows the list)' },
      handler: (invocation) => runModels(invocation, deps),
    },
    {
      name: 'genspark-run',
      description: 'Run an arbitrary tool read-only (writes go through the genspark_run tool)',
      input: { hint: 'tool name [JSON arguments] (e.g. me / web_search {"q":"…"})' },
      handler: (invocation) => runGeneric(invocation, deps),
    },
  ];
  // Social commands (social category) are registered as routing commands where "the AI picks the service and action".
  const social = [];
  if (wanted.has('social')) {
    for (const spec of SOCIAL_COMMANDS) {
      social.push({
        name: spec.name,
        description: spec.description,
        input: { hint: spec.hint },
        promptFor: (invocation) => socialPrompt(spec, invocation),
        handler: (invocation) => runSocialRoute(spec, invocation, deps),
      });
    }
  }
  commands = [...core, ...promoted, ...social];
  // Also pass command results to the model so the AI can interpret them in chat (disable with the commandFollowup setting).
  return commands.map((command) => ({ ...command, handler: withFollowup(command, deps) }));
}
