/**
 * Typed tools curated by category ("promoted tools").
 *
 * genspark_run can also reach all 302 tools, but the tool name and argument names have to be looked up every time.
 * Only frequently used tools with stable arguments are promoted to DSH tools so that argument discovery can be
 * skipped (that is the purpose of this file).
 *
 * Promoted tools use the same path as genspark_run (runner.runTool → gsk <tool> --args-file …).
 * Additional CLI options (the generated media `-o/--output-file`) are appended as toolArgs.
 *
 * Design contract:
 *   - So that nothing breaks when a concrete argument name changes, every tool provides an escape hatch `extra` (arbitrary JSON).
 *     `extra` only fills in keys that were not given as typed arguments (typed arguments take precedence).
 *     The CLI, however, rejects argument names that are not in the schema before calling the server (measured).
 *     extra can only pass parameters that exist in the tool schema but are not typed.
 *   - Invalid argument combinations are thrown by build() as an error message and returned to the model as-is.
 *   - None of the promoted tools require confirmation (requires_confirmation=false / interactive_only=false), so
 *     `--no-input` is always passed. They are not subject to write approval.
 */
import { closeSync, existsSync, openSync, readSync, renameSync, statSync } from 'node:fs';
import { extname, resolve as resolvePath } from 'node:path';
import { describeRun, isEnvelope, parseEnvelope, truncate, CRAWLER_HINT } from './result.js';
import {
  SOCIAL_ACTION_LABELS,
  SOCIAL_DEFAULT_LIMIT,
  SOCIAL_PLATFORMS,
  autoAction,
  formatSocialResult,
  normalizeSocialArgs,
  socialFailure,
} from './social.js';

/** Text output (same shape as the existing tools). */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
};

/** Extract the response `data` from the runner return value (also supports implementations that only provide stdout). */
function extractData(result) {
  if (result?.data !== undefined) return result.data;
  const parsed = parseEnvelope(result?.stdout);
  return isEnvelope(parsed.value) ? parsed.value.data : parsed.value;
}

/** Escape hatch for passing the remaining arguments that are not expressed as typed arguments. */
const EXTRA_PARAM = {
  type: 'json',
  description:
    'Optional JSON object for passing parameters that exist in the schema of this tool but are not provided as typed arguments above. ' +
    'Examples: tier / first_frame_url / video_urls / input_mode for video generation, repo_id / query_file for image generation. ' +
    'Keys specified as typed arguments take precedence. ' +
    'Passing a key that is not in the schema is rejected by the CLI before the server call (no credits are spent), so ' +
    'call genspark_tools with full=true to confirm the exact argument names.',
};

/** Save destination for generated media (passed to the CLI `-o/--output-file`). */
const SAVE_TO_PARAM = {
  type: 'string',
  description:
    'Path of the local file to save the generated artifact to (example: ./out/image.png). ' +
    'If omitted, only the URL is returned. Relative paths are resolved against the session working directory.',
};

/**
 * Model selection. It is intentionally not constrained by an enum, because models are added and retired
 * frequently on the Genspark side and a stale enum would create "unselectable models". The actual values are
 * returned from the catalog by genspark_models (/genspark-models). A broken id is rejected by the CLI before
 * the server call (no credits are spent).
 */
const MODEL_PARAM_IMAGE = {
  type: 'string',
  description:
    'Model to use (example: nano-banana-2-flash-lite / gpt-image-2 / fal-ai/flux-3). ' +
    'Defaults to nano-banana-2-flash-lite. The list of available models can be obtained from genspark_models (kind: "image").',
};

const MODEL_PARAM_VIDEO = {
  type: 'string',
  description:
    'Model to use (required. Example: kling/v3 / gemini/veo3.1 / wan/v2.7 / minimax/h3). ' +
    'For the list, see genspark_models (kind: "video"). Unless you want it silent, pay attention to audio_enable.',
};

const MODEL_PARAM_AUDIO = {
  type: 'string',
  description:
    'Model to use (example: alibaba/qwen-audio-3-tts / elevenlabs/v4-tts / elevenlabs/music). ' +
    'For the list, see genspark_models (kind: "audio"). The shape of params differs by model.',
};

/** Display names of the categories commonly used in practice. */
export const PROMOTED_CATEGORIES = {
  search: 'Search & research',
  media: 'Generated media',
  social: 'Social media',
};

/** Layer extra behind the typed arguments (typed arguments take precedence). */
function withExtra(typed, extra) {
  const result = { ...(typed ?? {}) };
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra)) {
      if (result[key] === undefined && value !== undefined) result[key] = value;
    }
  }
  return result;
}

/** Resolve save_to to the CLI `-o` option. */
function resolveSaveTo(saveTo, cwd) {
  const value = typeof saveTo === 'string' ? saveTo.trim() : '';
  if (value.length === 0) return null;
  return resolvePath(cwd, value);
}

/** Infer the actual file format from the first bytes (the CLI uses the `-o` name as-is, so it can disagree with the actual content). */
export function detectFileFormat(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(16);
    const read = readSync(fd, buffer, 0, 16, 0);
    if (read < 4) return null;
    const bytes = buffer.subarray(0, read);
    const ascii = bytes.toString('latin1');
    if (bytes[0] === 0x89 && ascii.startsWith('\x89PNG')) return { format: 'PNG', extension: '.png' };
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { format: 'JPEG', extension: '.jpg' };
    if (ascii.startsWith('GIF8')) return { format: 'GIF', extension: '.gif' };
    if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return { format: 'WebP', extension: '.webp' };
    if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return { format: 'WAV', extension: '.wav' };
    if (ascii.startsWith('OggS')) return { format: 'Ogg', extension: '.ogg' };
    if (ascii.slice(4, 8) === 'ftyp') {
      return ascii.slice(8, 12).startsWith('qt')
        ? { format: 'QuickTime', extension: '.mov' }
        : { format: 'MP4', extension: '.mp4' };
    }
    if (ascii.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
      return { format: 'MP3', extension: '.mp3' };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* Ignore if it cannot be closed */
      }
    }
  }
}

/**
 * Align the saved file extension with the actual content.
 *
 * Measured: `/genspark-image` saves to `genspark-out/<timestamp>-image-….png`, but what nano-banana returns is
 * JPEG (first bytes `FF D8 FF E0 … JFIF`). If the extension lies, viewers and image tools cannot open the file,
 * so determine the format from the first bytes and rename when they disagree (the rename is reported in the
 * report text).
 */
export function normalizeSavedFile(path) {
  const detected = detectFileFormat(path);
  if (!detected) return { path, format: null, renamed: false };
  const current = extname(path).toLowerCase();
  const same = current === detected.extension || (detected.extension === '.jpg' && current === '.jpeg');
  if (same) return { path, format: detected.format, renamed: false };
  const next = `${path.slice(0, path.length - current.length)}${detected.extension}`;
  try {
    renameSync(path, next);
    return { path: next, format: detected.format, renamed: true };
  } catch {
    return { path, format: detected.format, renamed: false };
  }
}

/** Report the existence, format, and size of the saved file in one line (also used from the command side). */
export function describeSavedFile(path) {
  try {
    if (existsSync(path)) {
      const normalized = normalizeSavedFile(path);
      const stats = statSync(normalized.path);
      const kind = normalized.format ? `${normalized.format} / ` : '';
      const moved = normalized.renamed ? ` (extension corrected because the actual content is ${normalized.format})` : '';
      return `Saved file: ${normalized.path} (${kind}${stats.size} bytes)${moved}`;
    }
  } catch {
    /* If it cannot be determined, fall back to the guidance below */
  }
  return `Saved file: ${path} (existence could not be confirmed; check the file information in the JSON and the stderr)`;
}

function requireString(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) throw new Error(`${label} is required.`);
  return text;
}

/**
 * Validate URL-oriented arguments (for crawler / summarize_large_document).
 *
 * Measured: when a Japanese question such as `/genspark-crawl This is a test. Yesterday…` is passed,
 * the CLI tries to fetch it as a URL and fails with an error such as
 * `No content found or crawler failed for …`.
 * Reject it here and return guidance to the model and the user.
 * Local files are allowed because the CLI uploads them automatically.
 */
function requireUrlOrFile(value, label, hint) {
  const text = requireString(value, label);
  if (/^https?:\/\//i.test(text)) return text;
  if (existsSync(text)) return text;
  const shown = text.length > 120 ? `${text.slice(0, 120)}…` : text;
  throw new Error(
    `${label} must be an http(s) URL or the path of an existing local file` +
      ` (received value: "${shown}"). ${hint}` +
      ' To pass the value to the CLI as-is, use genspark_run (or /genspark-run for the command).',
  );
}

function cleanObject(value) {
  const result = {};
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (entry !== undefined && entry !== null && !(typeof entry === 'string' && entry.length === 0)) result[key] = entry;
  }
  return result;
}

/** Extension categories handled by media analysis (query strings and fragments are stripped from URLs first). */
const MEDIA_VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv', '.wmv', '.mpg', '.mpeg'];
const MEDIA_AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.wma', '.opus', '.mp2'];

/** Classify a path/URL as image / video / audio (unknown is treated as image). */
export function mediaKindOf(media) {
  const clean = String(media ?? '').split('?')[0].split('#')[0];
  const ext = extname(clean).toLowerCase();
  if (MEDIA_VIDEO_EXTS.includes(ext)) return 'video';
  if (MEDIA_AUDIO_EXTS.includes(ext)) return 'audio';
  return 'image';
}

/**
 * Convert media (possibly several) into a gsk call. No model name is specified = the default general-purpose model.
 * - Images only … understand_images (passed together in image_urls)
 * - Video … analyze_media (the first item only; the instruction is passed as requirements)
 * - Audio … audio_transcribe (the first item only; transcription only)
 */
export function analyzeMediaArgs(mediaList, instruction) {
  const images = [];
  const videos = [];
  const audios = [];
  for (const media of mediaList) {
    const kind = mediaKindOf(media);
    if (kind === 'video') videos.push(media);
    else if (kind === 'audio') audios.push(media);
    else images.push(media);
  }
  if (images.length === 0 && videos.length > 0) {
    return { gsk: 'analyze_media', args: { media_urls: [videos[0]], requirements: instruction } };
  }
  if (images.length === 0 && audios.length > 0) {
    return { gsk: 'audio_transcribe', args: { audio_urls: [audios[0]] } };
  }
  return { gsk: 'understand_images', args: { image_urls: images, instruction } };
}

/** Actions where query is required (those that take a person or a word). */
const SOCIAL_QUERY_ACTIONS = new Set([
  'search_posts', 'search_users', 'get_posts_by_author', 'get_posts_by_user', 'get_user',
  'get_user_connections', 'get_users_by_keywords', 'count_posts', 'search_comments',
  'search_subreddits', 'get_subreddit_with_posts', 'get_subreddits_by_keywords',
]);

/** Actions where post_id / post_ids is required (those that start from an existing post). */
const SOCIAL_POST_ACTIONS = new Set([
  'get_comments', 'get_quotes', 'get_retweets', 'get_post_interacting_users', 'get_post_with_comments', 'get_posts_by_ids',
]);

/** Clamp limit to 1-100 (default 25). */
function socialLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return SOCIAL_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), 100);
}

const SOCIAL_LIMIT_PARAM = {
  type: 'integer',
  description:
    `Maximum number of items to display (default ${SOCIAL_DEFAULT_LIMIT}, max 100). ` +
    'The server ignores limit and returns 100 or more items, so they are cut and formatted here (raw data with raw=true).',
};

const SOCIAL_RAW_PARAM = {
  type: 'boolean',
  description: 'When true, return raw JSON without formatting (for when you need all items and all fields). Default false.',
};

/**
 * Actions that accept dates (start_date / end_date).
 *
 * Measured (2026-10-18): adding start_date to `get_posts_by_author` failed, and it succeeded when removed.
 * Some actions fail when a date is passed, so by default dates are sent only to search_posts,
 * and on failure the dates are dropped and the call is retried automatically once.
 */
const SOCIAL_DATE_ACTIONS = new Set(['search_posts']);

const SOCIAL_DATE_PARAMS = {
  start_date: {
    type: 'string',
    description: 'Start date (YYYY-MM-DD). Sent only for search_posts (ignored by other actions).',
  },
  end_date: {
    type: 'string',
    description: 'End date (YYYY-MM-DD). Sent only for search_posts (ignored by other actions).',
  },
};

/** Actions eligible for automatic retry (ones where transient failures were measured). */
const SOCIAL_RETRYABLE_ACTIONS = new Set([
  'search_posts',
  'search_users',
  'get_user',
  'get_posts_by_author',
  'get_posts_by_user',
  'get_subreddit_with_posts',
  'get_post_with_comments',
]);

/** Actions where retrying is pointless (known to be unsupported upstream). */
const SOCIAL_UNSUPPORTED_ACTIONS = new Set(['count_posts', 'search_comments', 'search_subreddits']);

/**
 * Return the arguments used for the single automatic retry on failure (null if not needed).
 * If dates were sent, drop them (to avoid failures caused by combining dates). Otherwise retry once with the same arguments.
 */
export function socialRetryArgs(args, data) {
  if (socialFailure(data) === undefined) return null;
  const action = String(args?.action ?? '');
  if (SOCIAL_UNSUPPORTED_ACTIONS.has(action)) return null;
  if (!SOCIAL_RETRYABLE_ACTIONS.has(action)) return null;
  const next = { ...(args ?? {}) };
  delete next.start_date;
  delete next.end_date;
  return next;
}

/** Argument definitions for the social search tools (swapped per platform). */
function socialParameters(platform) {
  const actions = SOCIAL_PLATFORMS[platform].actions;
  const params = {
    action: {
      type: 'string',
      enum: ['auto', ...actions],
      description:
        'auto (default) is determined from query ("@handle" → posts by that user, otherwise → search_posts). ' +
        `To specify it explicitly, use one of ${actions.join(' / ')}. ` +
        'get_user returns only id / username / name (no bio, follower count, or URL), so ' +
        'to learn about a person use search_users or get_posts_by_author.',
    },
    query: {
      type: 'string',
      description:
        'Word, username, or ID to look up (the meaning depends on action). ' +
        'Upstream search matches words loosely (close to OR), so one or two proper nouns work best. ' +
        'For user search use search_users; for the posts of a specific user use get_posts_by_author (with the username in query).',
    },
    post_id: { type: 'string', description: 'ID of the post to start from (get_comments / get_quotes / get_retweets, etc.).' },
    post_ids: { type: 'string', description: 'Comma-separated post IDs (for get_posts_by_ids).' },
    ...SOCIAL_DATE_PARAMS,
    limit: SOCIAL_LIMIT_PARAM,
    raw: SOCIAL_RAW_PARAM,
    extra: EXTRA_PARAM,
  };
  if (platform === 'reddit') {
    params.subreddit = { type: 'string', description: 'Filter by subreddit name (example: programming).' };
    params.sort = {
      type: 'string',
      enum: ['relevance', 'hot', 'top', 'new', 'comments'],
      description: 'Sort order for search_posts.',
    };
    params.time = {
      type: 'string',
      enum: ['hour', 'day', 'week', 'month', 'year', 'all'],
      description: 'Time range for search_posts.',
    };
    return params;
  }
  params.connection_type = {
    type: 'string',
    enum: ['followers', 'following'],
    description: 'Target of get_user_connections (default followers).',
  };
  if (platform === 'instagram') {
    params.interaction_type = {
      type: 'string',
      enum: ['likers', 'commenters'],
      description: 'Target of get_post_interacting_users (default likers).',
    };
  } else {
    params.interaction_type = {
      type: 'string',
      enum: ['retweeters', 'commenters', 'quoters'],
      description: 'Target of get_post_interacting_users (default retweeters).',
    };
    params.language = {
      type: 'string',
      description:
        'Filter by language (example: ja / en). For Japanese topics, **adding ja substantially changes accuracy** (without it, ' +
        'many same-spelling words from languages such as Italian get mixed in — measured).',
    };
  }
  return params;
}

/** build for the social search tools (argument validation, normalization, and passing formatting information). */
function buildSocialArgs(platform, args) {
  const meta = SOCIAL_PLATFORMS[platform];
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const requested = typeof args.action === 'string' ? args.action.trim() : '';
  const action = requested.length === 0 || requested === 'auto' ? autoAction(platform, query) : requested;
  if (!meta.actions.includes(action)) {
    throw new Error(
      `${meta.label} action must be one of ${meta.actions.join(' / ')} (auto is also allowed). ` +
        `Received value: "${requested}".`,
    );
  }
  if (SOCIAL_QUERY_ACTIONS.has(action) && query.length === 0) {
    throw new Error(
      `action="${action}" requires query. Example: query="${platform === 'reddit' ? 'local llm' : 'Genspark'}".`,
    );
  }
  if (SOCIAL_POST_ACTIONS.has(action) && !args.post_id && !args.post_ids) {
    throw new Error(`action="${action}" requires post_id (or post_ids).`);
  }
  if (action === 'get_posts_by_ids' && !args.post_ids) {
    throw new Error('action="get_posts_by_ids" requires post_ids (comma-separated).');
  }
  const limit = socialLimit(args.limit);
  const withDates = SOCIAL_DATE_ACTIONS.has(action);
  const typed = {
    action,
    query: query.length > 0 ? query : undefined,
    post_id: args.post_id,
    post_ids: args.post_ids,
    connection_type: args.connection_type,
    interaction_type: args.interaction_type,
    start_date: withDates ? args.start_date : undefined,
    end_date: withDates ? args.end_date : undefined,
    language: platform === 'x' ? args.language : undefined,
    subreddit: platform === 'reddit' ? args.subreddit : undefined,
    sort: platform === 'reddit' ? args.sort : undefined,
    time: platform === 'reddit' ? args.time : undefined,
    limit,
  };
  return {
    args: normalizeSocialArgs(platform, action, withExtra(cleanObject(typed), args.extra)),
    command: meta.command,
    render: { platform, action, query: typed.query, limit, raw: args.raw === true, language: typed.language },
  };
}

/**
 * Social media search tools (social category).
 *
 * Because `gsk social <platform> <action>` is a grouped command, it is passed to the CLI via
 * `command` (such as ['social','twitter']) rather than `gsk` (the tool name).
 * The response is a raw array of more than 100 items, so it is formatted down to 25 items by default (raw JSON with raw: true).
 */
function buildSocialSpecs() {
  const labels = SOCIAL_PLATFORMS;
  return [
    {
      name: 'genspark_x_search',
      category: 'social',
      gsk: labels.x.gsk,
      timeoutMs: 180000,
      description:
        'Search X (Twitter). You can retrieve posts, users, authors, comments, quotes, retweets, and followers. ' +
        'If action is omitted it is determined automatically ("@handle" → posts by that user, otherwise → post search). ' +
        'If you want to see "the reaction to this topic", just pass query with the defaults. ' +
        'Narrowing the search terms to one or two words tends to hit better (upstream search is close to OR, and long phrases produce more noise). ' +
        'For Japanese topics, add language="ja" (accuracy changes in measured tests). ' +
        'To find users use action="search_users"; for the posts of a specific user use action="get_posts_by_author" (with the username in query). ' +
        `Results are sorted newest first and the first 25 items are formatted (item count via limit, raw JSON via raw=true).`,
      parameters: socialParameters('x'),
      build: (args) => buildSocialArgs('x', args),
      retryArgs: socialRetryArgs,
      render: formatSocialResult,
    },
    {
      name: 'genspark_instagram_search',
      category: 'social',
      gsk: labels.instagram.gsk,
      timeoutMs: 180000,
      description:
        'Search Instagram. You can retrieve posts, users, profiles, comments, and the users who liked a post. ' +
        'If action is omitted it is determined automatically ("@handle" → posts by that user, otherwise → post search). ' +
        'Posts return the caption, likes/comments/play counts, and the post URL (formatted newest first). ' +
        `Item count via limit, raw JSON via raw=true. A single run can take 10-15 seconds.`,
      parameters: socialParameters('instagram'),
      build: (args) => buildSocialArgs('instagram', args),
      retryArgs: socialRetryArgs,
      render: formatSocialResult,
    },
    {
      name: 'genspark_reddit_search',
      category: 'social',
      gsk: labels.reddit.gsk,
      timeoutMs: 180000,
      description:
        'Search Reddit. You can retrieve posts, comments, users, and subreddits. ' +
        'If action is omitted it becomes a post search (narrow it with sort / time / subreddit). ' +
        'Suited to uses such as "I want to see the discussion on this topic" or "recent posts in r/xxx". ' +
        'Upstream word matching is quite loose, so **specifying a subreddit or narrowing to one word** tends to hit better' +
        ' (sort / time are hints to upstream and may not work). ' +
        'Result rows do not include score or comment count (sorting is by date only). ' +
        'action="get_post_with_comments" returns the post plus comments, action="get_subreddit_with_posts" returns the list of posts in r/xxx. ' +
        `Results are sorted newest first and the first 25 items are formatted (item count via limit, raw JSON via raw=true).`,
      parameters: socialParameters('reddit'),
      build: (args) => buildSocialArgs('reddit', args),
      retryArgs: socialRetryArgs,
      render: formatSocialResult,
    },
  ];
}

/**
 * Definition table of the promoted tools.
 *
 * - name     … DSH tool name (the genspark_ prefix avoids collisions with existing tools)
 * - category … key of PROMOTED_CATEGORIES
 * - gsk      … tool name on the Genspark CLI side
 * - build(args, cwd) … { args: Genspark arguments, options: additional CLI options, saveTo?: absolute path }
 */
export const PROMOTED_TOOLS = [
  {
    name: 'genspark_web_search',
    category: 'search',
    gsk: 'web_search',
    timeoutMs: 300000,
    description:
      'Run a Genspark Web search (equivalent to a conventional search engine; the results are JSON with title/snippet/URL). ' +
      'Use it to research the latest information, news, and general knowledge. It serves the same purpose as the DSH built-in web_search but uses the Genspark search backend. ' +
      'If there are too many results, anything beyond maxChars is omitted, so make q specific.',
    parameters: {
      q: { type: 'string', required: true, description: 'Search query (example: "latest AI news"). Natural language or keywords are both fine.' },
      extra: EXTRA_PARAM,
    },
    build: (args) => ({ args: withExtra({ q: requireString(args.q, 'q') }, args.extra) }),
  },
  {
    name: 'genspark_image_search',
    category: 'search',
    gsk: 'image_search',
    timeoutMs: 300000,
    description:
      'Search for images with Genspark. Returns image URLs, titles, and sources as JSON. ' +
      'Use it for requests such as "find me a photo of X" or to find reference images (image_urls) for generated media.',
    parameters: {
      query: { type: 'string', required: true, description: 'Image search term (example: "Eiffel Tower at sunset"). English is more reliable.' },
      extra: EXTRA_PARAM,
    },
    build: (args) => ({ args: withExtra({ query: requireString(args.query, 'query') }, args.extra) }),
  },
  {
    name: 'genspark_crawl',
    category: 'search',
    gsk: 'crawler',
    timeoutMs: 300000,
    description:
      'Fetch the page body at the specified URL and return it as Markdown (supports HTML, PDF, and Office documents). ' +
      'An option for when the DSH built-in web_fetch cannot retrieve the body, or when you want to read a PDF. ' +
      'For sites blocked by Cloudflare and similar, use render_js=true; if you need the raw HTML/JSON, use raw=true (fetch in parts with offset).',
    parameters: {
      url: { type: 'string', required: true, description: 'http/https URL.' },
      render_js: {
        type: 'boolean',
        description: 'Enable JS rendering (for 403 / Cloudflare / dynamic content). Default false.',
      },
      raw: { type: 'boolean', description: 'Return the raw response body without converting it to Markdown. Default false.' },
      offset: { type: 'integer', description: 'Byte position at which to start reading when raw=true (max 1048576). Use it to fetch the continuation.' },
      extra: EXTRA_PARAM,
    },
    build: (args) => ({
      args: withExtra(
        cleanObject({
          url: requireUrlOrFile(args.url, 'url', CRAWLER_HINT),
          render_js: args.render_js,
          raw: args.raw,
          offset: args.offset,
        }),
        args.extra,
      ),
    }),
  },
  {
    name: 'genspark_scholar_search',
    category: 'search',
    gsk: 'scholar_search',
    timeoutMs: 300000,
    description:
      'Search academic papers (returns title, authors, journal, and citation count). ' +
      'Use it for paper research or finding references. It also works without a project (assigned automatically on the server side).',
    parameters: {
      query: { type: 'string', required: true, description: 'Paper search query (example: "diffusion model for speech synthesis").' },
      extra: EXTRA_PARAM,
    },
    build: (args) => ({ args: withExtra({ query: requireString(args.query, 'query') }, args.extra) }),
  },
  {
    name: 'genspark_maps_search',
    category: 'search',
    gsk: 'maps_search',
    timeoutMs: 300000,
    description:
      'Look up maps, places, and routes (only for geography questions; do not use for general knowledge or weather).\n' +
      'Usage: engine="maps" for place search (query required), engine="maps_directions" for distance/route (start_addr and end_addr required).\n' +
      'query_type is one of search / place / distances / directions.',
    parameters: {
      query_type: {
        type: 'string',
        required: true,
        enum: ['search', 'place', 'distances', 'directions'],
        description: 'Kind of question.',
      },
      engine: { type: 'string', required: true, enum: ['maps', 'maps_directions'], description: 'Engine to use.' },
      query: { type: 'string', description: 'Search term when engine="maps" (example: "cafes around Tokyo Station").' },
      start_addr: { type: 'string', description: 'Origin address when engine="maps_directions".' },
      end_addr: { type: 'string', description: 'Destination address when engine="maps_directions".' },
      travel_mode: {
        type: 'string',
        enum: ['0', '1', '2', '3', '4', '6', '9'],
        description: 'Travel mode (Google Maps travel mode value: 0=car, 1=bicycle, 2=walking, 3=public transit, etc.).',
      },
      avoid: { type: 'string', enum: ['highways', 'tolls', 'ferries'], description: 'Avoidance options.' },
      prefer: { type: 'string', enum: ['bus', 'subway', 'train', 'tram_light_rail'], description: 'Preferred transit mode.' },
      extra: EXTRA_PARAM,
    },
    build: (args) => {
      const engine = requireString(args.engine, 'engine');
      const typed = {
        query_type: requireString(args.query_type, 'query_type'),
        engine,
        query: args.query,
        start_addr: args.start_addr,
        end_addr: args.end_addr,
        travel_mode: args.travel_mode,
        avoid: args.avoid,
        prefer: args.prefer,
      };
      if (engine === 'maps_directions') {
        requireString(args.start_addr, 'start_addr (when engine=maps_directions)');
        requireString(args.end_addr, 'end_addr (when engine=maps_directions)');
      } else {
        requireString(args.query, 'query (when engine=maps)');
      }
      return { args: withExtra(cleanObject(typed), args.extra) };
    },
  },
  {
    name: 'genspark_summarize_document',
    category: 'search',
    gsk: 'summarize_large_document',
    timeoutMs: 900000,
    description:
      'Load a large document (PDF, web page, Word, etc.) and answer the given question. ' +
      'Use it to summarize long material or to ask about a specific part. The URL may be a local file path (the CLI uploads it automatically). ' +
      'Processing can take a while.',
    parameters: {
      url: { type: 'string', required: true, description: 'URL of the document, or a local file path.' },
      question: { type: 'string', required: true, description: 'A specific question about the document (example: "List five key points").' },
      extra: EXTRA_PARAM,
    },
    build: (args) => ({
      args: withExtra(
        {
          url: requireUrlOrFile(
            args.url,
            'url',
            'Specify the URL of the document to summarize or a local file path (like crawler, this is a URL-oriented tool).',
          ),
          question: requireString(args.question, 'question'),
        },
        args.extra,
      ),
    }),
  },
  {
    name: 'genspark_generate_image',
    category: 'media',
    gsk: 'image_generation',
    timeoutMs: 900000,
    description:
      'Generate an image (generation from text, or editing/restyling with reference image_urls). ' +
      'English prompts are more reliable. Returns the URL of the generated image. ' +
      'If save_to is specified, the CLI downloads it locally. ' +
      'If you are unsure how to classify the request, write what you want in query, and if you have a reference image put the image URL (or local path) in image_urls.',
    parameters: {
      query: {
        type: 'string',
        description: 'Detailed description of the image to generate (English recommended). Text you want inside the image may be left as-is. When passing reference images in image_urls, also state what to do.',
      },
      image_urls: {
        type: 'array',
        items: { type: 'string' },
        description: 'URL or local path of the reference image (required for editing, restyling, or keeping the same person/product).',
      },
      model: MODEL_PARAM_IMAGE,
      thinking_level: { type: 'string', enum: ['minimal', 'medium', 'high'], description: 'Amount of thinking reserved for nano-banana-2.1 (ignored by other models).' },
      aspect_ratio: {
        type: 'string',
        enum: ['1:1', '4:3', '16:9', '9:16', '3:4', '2:3', '3:2', 'auto'],
        description: 'Aspect ratio. For image editing (with image_urls), auto is the safe choice.',
      },
      image_size: { type: 'string', enum: ['auto', '0.5k', '1k', '2k', '3k', '4k'], description: 'Resolution. Default auto.' },
      bbox: { type: 'array', items: { type: 'number' }, description: '[x1, y1, x2, y2] for the bbox segmentation model. Usually unnecessary.' },
      save_to: SAVE_TO_PARAM,
      extra: EXTRA_PARAM,
    },
    build: (args, cwd) => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      const urls = Array.isArray(args.image_urls) ? args.image_urls : undefined;
      if (query.length === 0 && (!urls || urls.length === 0)) {
        throw new Error('Specify at least one of query (a description of what to generate) or image_urls (reference images).');
      }
      const typed = cleanObject({
        query: query.length > 0 ? query : undefined,
        image_urls: urls,
        model: args.model,
        thinking_level: args.thinking_level,
        aspect_ratio: args.aspect_ratio,
        image_size: args.image_size,
        bbox: Array.isArray(args.bbox) ? args.bbox : undefined,
      });
      const saveTo = resolveSaveTo(args.save_to, cwd);
      return {
        args: withExtra(typed, args.extra),
        options: saveTo ? ['-o', saveTo] : [],
        saveTo,
      };
    },
  },
  {
    name: 'genspark_generate_video',
    category: 'media',
    gsk: 'video_generation',
    timeoutMs: 1800000,
    description:
      'Generate a video (from text, or with image_urls as the first frame/reference). ' +
      'query (an English prompt) and model are required. Generation can take several minutes; it waits for completion and returns the resulting URL. ' +
      'If you need audio, set audio_enable=true (audio-capable models only; higher cost). ' +
      'If save_to is specified, the CLI downloads it locally. ' +
      'Advanced parameters such as first_frame_url / video_urls / tier are passed via extra (check them with genspark_tools full=true).',
    parameters: {
      query: { type: 'string', required: true, description: 'Detailed description of the video to generate (English). Passed to the model as-is.' },
      model: MODEL_PARAM_VIDEO,
      image_urls: {
        type: 'array',
        items: { type: 'string' },
        description: 'URL or local path of the reference keyframe image (image-to-video; one image for single-image models).',
      },
      aspect_ratio: {
        type: 'string',
        enum: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '2:1', '3:2', '2:3', '21:9', '9:21', '5:4', '4:5'],
        description: 'Aspect ratio. For image-to-video, match the input image.',
      },
      duration: { type: 'number', description: 'Duration (seconds). Default 5. 0 = auto (some models only).' },
      video_size: {
        type: 'string',
        enum: ['auto', '480p', '720p', '768p', '1080p', '2K', '4k'],
        description: 'Resolution. Default auto (most models use 720p).',
      },
      audio_enable: { type: 'boolean', description: 'True when audio or narration is needed (kling/v3 is silent unless true).' },
      reference_mode: {
        type: 'boolean',
        description: 'Reference mode (use the image as a character/style reference instead of the first frame). image_urls required.',
      },
      save_to: SAVE_TO_PARAM,
      extra: EXTRA_PARAM,
    },
    build: (args, cwd) => {
      const typed = cleanObject({
        query: requireString(args.query, 'query'),
        model: requireString(args.model, 'model'),
        image_urls: Array.isArray(args.image_urls) ? args.image_urls : undefined,
        aspect_ratio: args.aspect_ratio,
        duration: args.duration,
        video_size: args.video_size,
        audio_enable: args.audio_enable,
        reference_mode: args.reference_mode,
      });
      const saveTo = resolveSaveTo(args.save_to, cwd);
      return {
        args: withExtra(typed, args.extra),
        options: saveTo ? ['-o', saveTo] : [],
        saveTo,
      };
    },
  },
  {
    name: 'genspark_generate_audio',
    category: 'media',
    gsk: 'audio_generation',
    timeoutMs: 900000,
    description:
      'Generate audio (speech, sound effects, music). For prompt, write the script to read aloud or a description of what to generate. ' +
      'The shape of params may differ by model. ' +
      'If save_to is specified, the CLI downloads it locally.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'For TTS, the script to read aloud; for music or sound effects, a description of what to generate.',
      },
      model: MODEL_PARAM_AUDIO,
      audio_type: { type: 'string', enum: ['speech', 'music', 'sound_effect'], description: 'Generation type. Default speech.' },
      params: {
        type: 'json',
        description: 'JSON of model-specific parameters (speakers, speed, duration, lyrics, output_format, etc.).',
      },
      speaker: { type: 'string', description: 'Preset voice (specify it in params when possible).' },
      duration: { type: 'integer', description: 'Duration of the sound effect or music in seconds (specify it in params when possible).' },
      lyrics: { type: 'string', description: 'Lyrics for song models (specify them in params when possible).' },
      file_name: { type: 'string', description: 'Name of the generated artifact (default "audio").' },
      save_to: SAVE_TO_PARAM,
      extra: EXTRA_PARAM,
    },
    build: (args, cwd) => {
      const typed = cleanObject({
        prompt: requireString(args.prompt, 'prompt'),
        model: args.model,
        audio_type: args.audio_type,
        params: args.params,
        speaker: args.speaker,
        duration: args.duration,
        lyrics: args.lyrics,
        file_name: args.file_name,
      });
      const saveTo = resolveSaveTo(args.save_to, cwd);
      return {
        args: withExtra(typed, args.extra),
        options: saveTo ? ['-o', saveTo] : [],
        saveTo,
      };
    },
  },
  {
    name: 'genspark_analyze_media',
    category: 'media',
    gsk: 'understand_images',
    timeoutMs: 900000,
    description:
      'Understand and describe the content of images, videos, and audio (uses the default general-purpose model; no model name needed). ' +
      'Images are handled with understand_images, video with analyze_media, and audio with audio_transcribe. Local files are uploaded automatically.',
    parameters: {
      media: {
        type: 'string',
        required: true,
        description: 'File path or URL of the image/video/audio (example: ./photo.jpg / https://example.com/video.mp4). Local files are uploaded automatically by the CLI.',
      },
      instruction: {
        type: 'string',
        description: 'Instruction (if omitted, the content is described in detail, in the same language the user is using). For video it is passed as requirements.',
      },
      extra: EXTRA_PARAM,
    },
    build: (args) => {
      const instruction =
        typeof args.instruction === 'string' && args.instruction.trim().length > 0
          ? args.instruction.trim()
          : 'Describe the content of this media in detail, in the same language the user is using.';
      // Attached files of the command (possibly several) arrive as media_list. They are not used from the tool.
      const list = Array.isArray(args.media_list)
        ? args.media_list.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
        : [];
      const mediaList = list.length > 0
        ? list
        : [requireUrlOrFile(args.media, 'media', 'Specify the path or URL of the image/video/audio.')];
      const built = analyzeMediaArgs(mediaList, instruction);
      return { gsk: built.gsk, args: withExtra(built.args, args.extra) };
    },
  },
  ...buildSocialSpecs(),
];

/** Resolve the set of enabled category names (when unspecified: search & research + generated media). */
export function resolvePromotedCategories(categories, log) {
  const list = Array.isArray(categories) ? categories : ['search', 'media'];
  const wanted = new Set();
  for (const entry of list) {
    const key = String(entry ?? '').trim();
    if (key.length === 0) continue;
    if (!Object.hasOwn(PROMOTED_CATEGORIES, key)) {
      log?.(`[genspark] ignoring unknown category "${key}" (search / media / social)`);
      continue;
    }
    wanted.add(key);
  }
  return wanted;
}

/** One-line summary for genspark_status. */
export function promotedSummary(categories) {
  const wanted = resolvePromotedCategories(categories);
  const parts = [];
  for (const [key, label] of Object.entries(PROMOTED_CATEGORIES)) {
    const count = PROMOTED_TOOLS.filter((spec) => spec.category === key).length;
    if (count === 0) continue;
    parts.push(`${key}=${label} ${count} tools${wanted.has(key) ? '' : ' (disabled)'}`);
  }
  return parts.join(' / ');
}

/** Assemble the promoted tools for the specified categories as DSH tools. */
export function buildPromotedTools({ defineTool, getConfig, runner, catalog, log, categories } = {}) {
  const config = () => (typeof getConfig === 'function' ? getConfig() : getConfig) ?? {};
  const wanted = resolvePromotedCategories(categories ?? config().promotedCategories, log);

  return PROMOTED_TOOLS.filter((spec) => wanted.has(spec.category)).map((spec) =>
    defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const cfg = config();
        const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();

        let built;
        try {
          built = spec.build(args ?? {}, cwd);
        } catch (error) {
          return `${error?.message ?? error}`;
        }

        // If build returns a gsk, prefer it (e.g. the extension branching for media analysis)
        const gsk = typeof built.gsk === 'string' && built.gsk.length > 0 ? built.gsk : spec.gsk;
        // Generated media (such as video) has a longer floor than the configured value
        const timeoutMs = Math.max(Number(cfg.timeoutMs ?? 600000), Number(spec.timeoutMs ?? 0));
        const invoke = (payload) =>
          runner.runTool(gsk, payload, {
            cwd,
            signal: exec?.signal,
            timeoutMs,
            globalArgs: ['--output', 'json', '--timeout', String(timeoutMs), '--no-input'],
            toolArgs: built.options ?? [],
            // Grouped commands (social_twitter → `gsk social twitter`) are resolved here
            toolCommand: built.command,
          });

        let result;
        try {
          result = await invoke(built.args);
        } catch (error) {
          if (error?.code === 'GSK_ENTRY_NOT_FOUND') return error.message;
          return `Execution failed: ${error?.message ?? String(error)}`;
        }

        // Transient social failures (measured: the same arguments succeed a little later) are retried automatically once
        if (typeof spec.retryArgs === 'function' && result.ok) {
          const retryPayload = spec.retryArgs(built.args, extractData(result));
          if (retryPayload) {
            const waitMs = Number(cfg.socialRetryDelayMs ?? 1500);
            if (Number.isFinite(waitMs) && waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
            try {
              const retried = await invoke(retryPayload);
              if (retried.ok) {
                built = { ...built, args: retryPayload };
                result = retried;
                log?.(`[genspark] retried ${gsk} automatically (succeeded)`);
              }
            } catch (error) {
              log?.(`[genspark] automatic retry of ${gsk} failed: ${error?.message ?? error}`);
            }
          }
        }

        const described = describeRun(result, { tool: gsk, maxChars: Number(cfg.maxOutputChars ?? 100000) });
        if (cfg.debug && result.stderr?.trim()) {
          log?.(`[genspark] ${gsk} stderr: ${result.stderr.trim().slice(0, 500)}`);
        }
        let text = described.text;
        // For social tools, format the raw array (100+ items) into a readable list. With raw=true, return the JSON as-is.
        if (described.ok && built.render) {
          const maxChars = Number(cfg.maxOutputChars ?? 100000);
          const data = extractData(result);
          if (built.render.raw === true) {
            const json = JSON.stringify(data, null, 2);
            if (typeof json === 'string') text = truncate(json, maxChars).text;
          } else if (typeof spec.render === 'function') {
            try {
              text = truncate(spec.render(data, built.render), maxChars).text;
            } catch (error) {
              log?.(`[genspark] failed to format the result of ${gsk}: ${error?.message ?? error}`);
            }
          }
        }
        if (built.saveTo && described.ok) text += `\n${describeSavedFile(built.saveTo)}`;
        return text;
      },
    }),
  );
}
