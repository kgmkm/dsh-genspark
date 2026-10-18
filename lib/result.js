/**
 * The layer that interprets gsk's standard output.
 *
 * Two output shapes confirmed by measurement:
 *   1. Tool execution: ApiResponse envelope
 *      { status: 'ok'|'error', message, data, error_code?, http_status?, retry_after?, instruction_for_agent? }
 *   2. `gsk ls` (catalog): outputs { tools: ToolSchema[], features?: {...} } directly, without an envelope
 *
 * Success is determined mainly by whether stdout could be read as JSON, not by the exit code
 * (because an execution where auto-update ran can yield exit code 0xC0000409).
 */

/** Whether the object looks like an envelope (has status). */
export function isEnvelope(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof value.status === 'string';
}

/**
 * Extract a single JSON object from stdout.
 * The default is one-line JSON, but it scans from the back to tolerate future multi-line output and finally tries the full text.
 */
export function parseEnvelope(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line.length === 0 || (line[0] !== '{' && line[0] !== '[')) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') return { value, raw: line, line: index + 1 };
    } catch {
      /* Try the next candidate */
    }
  }
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === 'object') return { value, raw: trimmed, line: null };
    } catch {
      /* Not JSON */
    }
  }
  return { value: undefined, raw: trimmed.slice(-2000), line: null };
}

/** Thin wrapper kept for backward compatibility (old name). */
export function parseGskOutput(stdout) {
  const { value, raw } = parseEnvelope(stdout);
  return { envelope: isEnvelope(value) ? value : undefined, value, raw };
}

export const AUTH_HINT =
  'Genspark is not authenticated. Run `gsk login` in a terminal (`gsk.cmd login` in PowerShell because of the execution policy).';
export const CONFIRM_HINT =
  'This operation requires confirmation on the Genspark CLI side, and it was not executed because no approval was passed (no server call).' +
  ' Obtain the user\'s approval and run it again with approve_write=true.';
export const INTERACTIVE_HINT =
  'This operation requires interaction (interactive_only). It cannot be executed from the plugin, so the user must run it manually.';
export const CRAWLER_HINT =
  'crawler is a tool that receives a "page URL" (it fetches the body and converts it to Markdown).' +
  ' Passing a question in Japanese makes it try to fetch that as a URL, which produces this error.' +
  ' To research a question, use web_search (or the /genspark-search command).';

/** Truncate an overly long result (respect the limit while keeping the tail). */
export function truncate(text, maxChars) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 100000;
  if (text.length <= limit) return { text, truncated: false, originalLength: text.length };
  return {
    text: `${text.slice(0, limit)}\n\n… (${text.length - limit} more characters omitted. Use keyword / limit to narrow the results if needed)`,
    truncated: true,
    originalLength: text.length,
  };
}

/**
 * Extract the main analysis text from the data of media-analysis tools (preferring analysis / transcription / result).
 * Looks at arrays (such as `{results:[{url, result}]}`) and nested objects up to 2 levels deep.
 */
const MEDIA_TEXT_KEYS = [
  'analysis', 'analysis_text', 'transcription', 'transcript', 'transcript_text',
  'result', 'text', 'content', 'markdown', 'answer',
];
const MEDIA_META_KEYS = [
  'analysis_result_url', 'result_url', 'audio_url', 'video_url', 'words_url', 'file_type', 'filename',
];

/**
 * Body-text keys for transcription tools (audio_transcribe).
 * The measured response looks like `{ "<url>": { status, audio_url, language, full_text, segments, words, … } }`,
 * where `full_text` is often an empty string, the body is in `segments` (`0.00-5.52: text`), and `words`
 * holds word-level timestamps (20 to several hundred entries). `words` is not displayed.
 */
const TRANSCRIPT_TEXT_KEYS = ['full_text', 'transcript_text', 'transcript', 'segments'];
const TRANSCRIPT_META_KEYS = [
  'language', 'audio_url', 'video_url', 'analysis_result_url', 'words_url', 'file_type', 'filename',
];

/** Extract the body text of one transcript (segments when full_text is empty). */
function transcriptTextOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const fullText = typeof value.full_text === 'string' ? value.full_text.trim() : '';
  if (fullText.length > 0) return fullText;
  for (const key of ['transcript_text', 'transcript']) {
    const text = value[key];
    if (typeof text === 'string' && text.trim().length > 0) return text.trim();
  }
  const segments = value.segments;
  if (typeof segments === 'string' && segments.trim().length > 0) return segments.trim();
  if (Array.isArray(segments) && segments.length > 0) {
    const lines = segments
      .map((segment) => {
        if (typeof segment === 'string') return segment.trim();
        if (segment === null || typeof segment !== 'object') return '';
        const text = typeof segment.text === 'string' ? segment.text.trim() : '';
        if (text.length === 0) return '';
        const start = typeof segment.start === 'number' ? `${segment.start.toFixed(2)}-` : '';
        const end = typeof segment.end === 'number' ? segment.end.toFixed(2) : '';
        return start.length > 0 ? `${start}${end}: ${text}` : text;
      })
      .filter((line) => line.length > 0);
    if (lines.length > 0) return lines.join('\n');
  }
  return undefined;
}

/** Collect transcript-style data (nesting up to 2 levels). */
function collectTranscripts(data) {
  const entries = [];
  const scan = (value, depth) => {
    if (value === null || typeof value !== 'object' || depth > 2) return;
    if (Array.isArray(value)) {
      for (const item of value) scan(item, depth + 1);
      return;
    }
    const isTranscript = TRANSCRIPT_TEXT_KEYS.some((key) => key in value);
    const text = isTranscript ? transcriptTextOf(value) : undefined;
    if (text !== undefined) {
      entries.push({ text, source: value });
      return;
    }
    for (const nested of Object.values(value)) {
      if (nested !== null && typeof nested === 'object') scan(nested, depth + 1);
    }
  };
  scan(data, 0);
  return entries;
}

function collectMediaEntries(data) {
  const entries = [];
  const scan = (value, depth) => {
    if (value === null || typeof value !== 'object' || depth > 2) return;
    if (Array.isArray(value)) {
      for (const item of value) scan(item, depth + 1);
      return;
    }
    for (const key of MEDIA_TEXT_KEYS) {
      const text = value[key];
      if (typeof text === 'string' && text.trim().length > 0) {
        entries.push({ text: text.trim(), source: value });
        return;
      }
    }
    for (const nested of Object.values(value)) {
      if (nested !== null && typeof nested === 'object') scan(nested, depth + 1);
    }
  };
  scan(data, 0);
  return entries;
}

/** Combine the body text plus auxiliary info (such as URLs) of entries into one text. */
function formatEntries(entries, metaKeys, maxChars) {
  const blocks = entries.map((entry) => entry.text);
  const meta = new Set();
  for (const entry of entries) {
    for (const key of metaKeys) {
      const value = entry.source?.[key];
      if (typeof value === 'string' && value.length > 0) meta.add(`${key}: ${value}`);
    }
  }
  const text = [...blocks, ...meta].join('\n\n');
  return text.length > 0 ? truncate(text, maxChars).text : undefined;
}

/** When converting to JSON, fold the word-level timestamps (`words`) since they are huge. */
function jsonReplacer(key, value) {
  if (key === 'words' && (typeof value === 'string' || Array.isArray(value))) {
    const size = typeof value === 'string' ? value.length : value.length;
    return `(word-level timestamps: ${size} entries omitted)`;
  }
  return value;
}

/** Format data into text for the model to read. */
export function formatData(data, maxChars) {
  if (data === undefined) return '(no data)';
  // For transcripts, emit only the body text (full_text / segments). Do not emit words
  const transcripts = collectTranscripts(data);
  if (transcripts.length > 0) {
    const text = formatEntries(transcripts, TRANSCRIPT_META_KEYS, maxChars);
    if (text !== undefined) return text;
  }
  // For media analysis, emit the analysis body text (analysis / result); do not emit huge JSON
  const entries = collectMediaEntries(data);
  if (entries.length > 0) {
    const text = formatEntries(entries, MEDIA_META_KEYS, maxChars);
    if (text !== undefined) return text;
  }
  let text;
  if (typeof data === 'string') text = data;
  else {
    try {
      text = JSON.stringify(data, jsonReplacer, 2);
    } catch {
      text = String(data);
    }
  }
  return truncate(text, maxChars).text;
}

/**
 * Reduce an execution result to a single text for the model.
 * @returns {{ ok: boolean, text: string }}
 */
export function describeRun(result, { tool, maxChars } = {}) {
  const { value, raw } = parseEnvelope(result.stdout);

  if (result.aborted) return { ok: false, text: 'Execution was canceled.' };
  if (result.timedOut) {
    return {
      ok: false,
      text:
        `Genspark-side processing did not finish within the time limit (tool: ${tool}).` +
        ' For long-running operations (task create / deep_research / video_generation, etc.), use a path that receives a run_id or project_id ' +
        'without waiting for the result, and checks it later with task_status / task_info.',
    };
  }

  // 1) ApiResponse envelope
  if (isEnvelope(value)) {
    if (value.status === 'error') {
      const parts = [`Genspark API error: ${value.message ?? '(no message)'}`];
      if (value.error_code) parts.push(`error_code: ${value.error_code}`);
      if (value.http_status) parts.push(`http_status: ${value.http_status}`);
      if (value.retry_after) parts.push(`retry_after: ${value.retry_after} seconds (retry after this delay)`);
      if (value.instruction_for_agent) parts.push(`Instruction: ${value.instruction_for_agent}`);
      if (typeof value.message === 'string' && /api key/i.test(value.message)) parts.push(AUTH_HINT);
      if (typeof value.message === 'string' && /crawler failed|error fetching url/i.test(value.message)) {
        parts.push(CRAWLER_HINT);
      }
      return { ok: false, text: parts.join('\n') };
    }
    // A message of just "success" carries no information, so omit it (to keep the body readable)
    const message = typeof value.message === 'string' ? value.message.trim() : '';
    const head = message.length > 0 && !/^(success|ok|done)$/i.test(message) ? `${message}\n` : '';
    return { ok: true, text: `${head}${formatData(value.data, maxChars)}` };
  }

  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const stdoutEmpty = typeof result.stdout !== 'string' || result.stdout.trim().length === 0;

  // 2) Stopped at a confirmation prompt (behavior with --no-input: exit code 2 / no server call)
  if (result.code === 2) return { ok: false, text: CONFIRM_HINT };

  // 3) No authentication
  if (/API key is required/i.test(stderr)) return { ok: false, text: `${AUTH_HINT}\n(${stderr.trim().split('\n')[0] ?? ''})` };

  // 4) Incorrect argument name. The CLI validates --args-file against the schema before calling the server,
  //    so this error does not spend credits (measured: `[ERROR] --args-file: "x" is not a param`).
  //    Note: do not decide based only on the `--args-file` word. Otherwise other failures such as an unreadable file
  //    (ENOENT, etc.) would be misdiagnosed as "incorrect argument name", so limit the symptom.
  if (/is not a param/i.test(stderr)) {
    return {
      ok: false,
      text:
        `The argument names do not match the Genspark-side schema (tool: ${tool}). The server was not called.\n` +
        'Use genspark_tools (keyword=<tool name>, full=true) to check the exact argument names.\n' +
        stderr.trim().slice(0, 600),
    };
  }

  // 4b) The CLI could not read the arguments file itself (a plugin-side defect; retrying does not fix it)
  if (/--args-file/i.test(stderr) && /ENOENT|EACCES|EPERM|no such file/i.test(stderr)) {
    return {
      ok: false,
      text:
        `The Genspark CLI could not read the arguments file (tool: ${tool} / exit code: ${result.code ?? 'unknown'}).` +
        ' This is a temporary-file creation problem on the plugin side (the server was not called).\n' +
        stderr.trim().slice(0, 600),
    };
  }

  // 5) Nonexistent tool or argument error
  if (/unknown command|unknown option|error: unknown/i.test(stderr)) {
    return { ok: false, text: `The CLI could not interpret the command/option (tool: ${tool}).\n${stderr.trim().slice(0, 1200)}` };
  }

  // 6) Otherwise: stdout is not JSON (text output, crash, or empty)
  const detail = [
    `Could not interpret the Genspark CLI output as JSON (tool: ${tool} / exit code: ${result.code ?? 'unknown'}).`,
    stdoutEmpty ? 'stdout was empty.' : `stdout head: ${raw.slice(0, 400)}`,
    stderr.trim().length > 0 ? `stderr: ${stderr.trim().slice(0, 1200)}` : '',
  ].filter(Boolean);
  return { ok: false, text: detail.join('\n') };
}
