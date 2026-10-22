/**
 * Genspark search provider for the web capability seam (`ctx.web`), plus the provider-selection
 * handover that turns it into a drop-in replacement for the built-in `web_search`.
 *
 * Why a seam provider instead of a local proxy / an HTTP shim:
 *   - `ctx.web.registerSearchProvider()` is the documented plugin API of `@deepseek-ai/dsh-web`.
 *     Both built-in DeepSeek backends (`deepseek-search-api` / `deepseek-official`) are ordinary
 *     plugin packages that register through this same call, so nothing in DSH is patched.
 *   - Which provider wins is `web.searchProvider`, a normal (volatile) settings field. The official
 *     "Web search" page writes exactly that field, so the handover below uses the supported settings
 *     surface rather than rewriting un-configurable state.
 *   - Fewer moving parts than a proxy: no port, no extra process, no key file to keep in sync.
 *
 * Default OFF: while `webSearch.enabled` is false nothing is registered and no setting is touched.
 *
 * Cost note: a search spends Genspark credits and pays the `gsk` process start-up (the CLI is
 * spawned per query), so the provider is opt-in.
 */
import { describeRun } from './result.js';

/** Stable provider id registered in the search registry (and the value written to `web.searchProvider`). */
export const GENSPARK_SEARCH_PROVIDER_ID = 'genspark';

/** Settings namespace that owns the provider selection (`@deepseek-ai/dsh-web` is mounted as `web`). */
export const WEB_SETTINGS_NS = 'web';

/** Timeout for one search (same bound as the `genspark_web_search` tool). */
export const SEARCH_TIMEOUT_MS = 300000;

/** Failure classes the seam's consumers already understand (see `@deepseek-ai/dsh-web`). */
export const WEB_PROVIDER_ERROR = 'WEB_PROVIDER_ERROR';
export const WEB_ABORTED = 'WEB_ABORTED';

/**
 * Provider failure with a machine-routable `code`.
 *
 * `@deepseek-ai/dsh-web` exports `WebError`, but a third-party plugin resolves bare specifiers
 * through the host's importer; duplicating the four-line shape keeps this plugin loadable when that
 * package is not on the resolution path (consumers route on `error.code`, not on the constructor).
 */
export class WebProviderError extends Error {
  /**
   * @param {string} message - Human- and model-readable failure description.
   * @param {string} code - Stable failure class (`WEB_PROVIDER_ERROR` / `WEB_ABORTED`).
   * @param {object} [options] - Standard `Error` options (`cause`).
   */
  constructor(message, code, options) {
    super(message, options);
    this.name = 'WebProviderError';
    this.code = code;
  }
}

/**
 * Read a config value that may be a live (volatile) reference.
 *
 * A schemastery field declared `.volatile()` reaches the plugin as `{ get() }` instead of a plain
 * value, because the host updates it in place without remounting the plugin. Plain values (tests,
 * older hosts) pass through unchanged.
 *
 * @param {unknown} value - Plain value or volatile reference.
 * @param {unknown} fallback - Used when the value is `undefined`.
 * @returns {unknown} The current value.
 */
export function readLive(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    const current = value.get();
    return current === undefined ? fallback : current;
  }
  return value === undefined ? fallback : value;
}

/** Keys Genspark uses for the result list, in preference order. */
const LIST_KEYS = [
  'organic_results',
  'results',
  'items',
  'web_results',
  'search_results',
  'sources',
  'entries',
  'data',
];

const URL_KEYS = ['url', 'link', 'href', 'source_url', 'displayed_url'];
const TITLE_KEYS = ['title', 'name', 'heading'];
const SNIPPET_KEYS = ['snippet', 'description', 'summary', 'text', 'content', 'abstract'];
const DATE_KEYS = ['date', 'publishedAt', 'published_at', 'published', 'timestamp', 'time'];
const CONTENT_KEYS = ['answer', 'ai_answer', 'answer_text', 'summary', 'abstract'];

/** First non-empty string value among `keys`. */
function pickString(value, keys) {
  if (value === null || typeof value !== 'object') return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  return undefined;
}

/**
 * Find the first array of records anywhere under `value` (bounded depth).
 *
 * The shape of `gsk web_search` output is documented only as "titles, snippets, and URLs"; the
 * measured envelope nests them under `organic_results`, but batch/related variants differ. Searching
 * by preference order keeps the mapping working when the CLI adds a wrapper layer.
 *
 * @param {unknown} value - Parsed `data` of the CLI envelope.
 * @param {number} [depth] - Remaining descent budget.
 * @returns {unknown[]|undefined} The first array found, if any.
 */
function findResultList(value, depth = 0) {
  if (Array.isArray(value)) return value;
  if (depth > 2 || value === null || typeof value !== 'object') return undefined;
  for (const key of LIST_KEYS) {
    const list = findResultList(value[key], depth + 1);
    if (list !== undefined) return list;
  }
  return undefined;
}

/** Normalize one CLI record to a citeable source, or `undefined` when it has no usable URL. */
function toSource(record) {
  if (record === null || typeof record !== 'object') return undefined;
  const url = pickString(record, URL_KEYS);
  if (url === undefined || !/^https?:\/\//i.test(url)) return undefined;
  const source = { url };
  const title = pickString(record, TITLE_KEYS);
  if (title !== undefined) source.title = title;
  const snippet = pickString(record, SNIPPET_KEYS);
  if (snippet !== undefined) source.snippet = snippet;
  const rawDate = pickString(record, DATE_KEYS);
  if (rawDate !== undefined) {
    const stamp = Date.parse(rawDate);
    // The seam documents `publishedAt` as ISO-8601; a value that does not parse ("2 days ago")
    // is dropped rather than passed on as a lie.
    if (Number.isFinite(stamp)) source.publishedAt = new Date(stamp).toISOString();
  }
  return source;
}

/**
 * Project the CLI's search payload onto the seam's result vocabulary.
 *
 * @param {unknown} data - `envelope.data` (or the bare parsed value) of `gsk web_search`.
 * @returns {{sources: Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>, content?: string}}
 *   Citeable sources in provider order (deduplicated by URL) and optional provider-generated answer text.
 */
export function normalizeWebSearchResult(data) {
  const sources = [];
  const seen = new Set();
  const list = findResultList(data);
  for (const record of Array.isArray(list) ? list : []) {
    const source = toSource(record);
    if (source === undefined || seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push(source);
  }
  const result = { sources };
  const content = pickString(data, CONTENT_KEYS);
  if (content !== undefined) result.content = content;
  return result;
}

/** Build a `WEB_ABORTED` failure, retaining the caller's reason when one exists. */
function abortedError(signal, cause) {
  const reason = signal?.aborted === true ? signal.reason : cause;
  return new WebProviderError('Genspark web search was canceled', WEB_ABORTED, { cause: reason });
}

/** Message of an unknown thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

const ENTRY_HINT =
  'Install @genspark/cli (npm install -g @genspark/cli) and run `gsk login`, or set the absolute path to ' +
  'dist/index.js in the dsh-genspark setting cliEntry.';

/**
 * Create the `genspark` search provider.
 *
 * `available()` is a local check only (the seam forbids network calls there): the feature must be
 * enabled and the CLI entry must exist. `search()` runs one `gsk web_search` and maps the payload.
 *
 * @param {object} options
 * @param {() => object} options.getConfig - Live plugin config (called per operation).
 * @param {object} options.runner - Runner from `lib/gsk-cli.js` (`runTool` / `resolveEntry`).
 * @param {() => boolean} [options.isEnabled] - Whether the feature is enabled (defaults to config).
 * @param {(message: string) => void} [options.log] - Debug sink.
 * @returns {{id: string, available: () => boolean, search: (request: object, signal?: AbortSignal) => Promise<object>}}
 */
export function createGensparkSearchProvider({ getConfig, runner, isEnabled, log } = {}) {
  const configOf = () => (typeof getConfig === 'function' ? getConfig() : getConfig) ?? {};
  const enabled = () => {
    if (typeof isEnabled === 'function') return isEnabled() === true;
    return readLive(configOf().webSearch?.enabled, false) === true;
  };

  return {
    id: GENSPARK_SEARCH_PROVIDER_ID,

    available() {
      try {
        if (enabled() !== true) return false;
        const entry = runner?.resolveEntry?.();
        return typeof entry === 'string' && entry.length > 0;
      } catch {
        return false;
      }
    },

    async search(request, signal) {
      const query = typeof request?.query === 'string' ? request.query.trim() : '';
      if (query.length === 0) {
        throw new WebProviderError('Genspark web search was called without a query.', WEB_PROVIDER_ERROR);
      }
      if (signal?.aborted === true) throw abortedError(signal);

      let result;
      try {
        result = await runner.runTool('web_search', { q: query }, { signal, timeoutMs: SEARCH_TIMEOUT_MS });
      } catch (error) {
        if (signal?.aborted === true) throw abortedError(signal, error);
        throw new WebProviderError(
          `Genspark web search could not start: ${messageOf(error)}\n\n${ENTRY_HINT}`,
          WEB_PROVIDER_ERROR,
          { cause: error },
        );
      }
      if (result?.aborted === true) throw abortedError(signal);

      if (result?.ok !== true) {
        // Reuse the plugin's single failure describer so the wording (auth hints, argument mismatches,
        // timeouts, raw stderr) matches what the genspark_web_search tool reports.
        const described = describeRun(result ?? {}, { tool: 'web_search' });
        throw new WebProviderError(described.text, WEB_PROVIDER_ERROR);
      }

      const { sources, content } = normalizeWebSearchResult(result.data);
      if (sources.length === 0 && content === undefined) {
        throw new WebProviderError(
          `Genspark web_search returned no results for ${JSON.stringify(query)}. ` +
            'Make the query specific (keywords rather than a sentence) or fall back to the genspark_web_search tool.',
          WEB_PROVIDER_ERROR,
        );
      }
      log?.(`[genspark] web search: ${sources.length} sources for ${JSON.stringify(query)}`);
      // The seam applies `request.maxResults` itself and sets `truncated` when it cuts.
      return content === undefined ? { sources, truncated: false } : { sources, content, truncated: false };
    },
  };
}

/**
 * Hand the provider selection over and back again.
 *
 * Turning the feature on writes `web.searchProvider = 'genspark'` (the same field the official
 * Web search page writes). Turning it off restores the value the user had chosen before, or clears
 * the field so the seam's automatic selection applies again.
 *
 * The previous explicit choice is remembered in memory for the running process. It is not persisted:
 * a restart while the feature is enabled keeps the selection, and a restart after it is disabled is
 * a normal "automatic selection" state.
 *
 * @param {object} options
 * @param {() => object|undefined} options.getSettings - The host's `settings` service, if present.
 * @param {(message: string) => void} [options.log] - Warning sink.
 * @returns {{take: () => Promise<object>, release: () => Promise<object>, pending: () => (string|undefined)}}
 */
export function createSearchSelectionGuard({ getSettings, log, providerId = GENSPARK_SEARCH_PROVIDER_ID } = {}) {
  /** Explicit user-layer value captured when the plugin took the selection over. */
  let previous = { captured: false, value: undefined };

  const reset = () => {
    previous = { captured: false, value: undefined };
  };

  const readRow = () => {
    const settings = typeof getSettings === 'function' ? getSettings() : undefined;
    if (settings === undefined || settings === null || typeof settings.describe !== 'function') {
      return { settings: undefined, row: undefined };
    }
    let rows;
    try {
      rows = settings.describe();
    } catch (error) {
      log?.(`[genspark] could not read the settings document: ${messageOf(error)}`);
      return { settings, row: undefined };
    }
    return { settings, row: Array.isArray(rows) ? rows.find((entry) => entry?.ns === WEB_SETTINGS_NS) : undefined };
  };

  return {
    /** Point `web.searchProvider` at this plugin's provider. */
    async take() {
      const { settings, row } = readRow();
      if (settings === undefined) return { applied: false, reason: 'the host exposes no settings service' };
      if (row === undefined) return { applied: false, reason: 'the host exposes no "web" settings entry' };
      const current = row.value?.searchProvider;
      if (current === providerId) return { applied: true, alreadySelected: true };
      if (!previous.captured) {
        const chosen = row.user?.searchProvider;
        previous = { captured: true, value: typeof chosen === 'string' && chosen.length > 0 ? chosen : undefined };
      }
      try {
        await settings.update(WEB_SETTINGS_NS, { searchProvider: providerId });
        return { applied: true };
      } catch (error) {
        return { applied: false, reason: messageOf(error) };
      }
    },

    /** Give the selection back: the previous explicit choice, or the automatic selection. */
    async release() {
      const { settings, row } = readRow();
      if (settings === undefined || row === undefined) {
        reset();
        return { released: false, reason: 'the host exposes no writable "web" settings entry' };
      }
      const current = row.value?.searchProvider;
      if (current !== providerId) {
        // The user picked something else after us; never fight over the field.
        reset();
        return { released: false, reason: 'the selection had already changed' };
      }
      try {
        if (typeof previous.value === 'string' && previous.value.length > 0) {
          await settings.update(WEB_SETTINGS_NS, { searchProvider: previous.value });
        } else if (typeof settings.mutate === 'function') {
          await settings.mutate(WEB_SETTINGS_NS, [{ op: 'unset', path: ['searchProvider'] }]);
        } else {
          reset();
          return { released: false, reason: 'this host cannot clear a settings field' };
        }
        reset();
        return { released: true };
      } catch (error) {
        reset();
        return { released: false, reason: messageOf(error) };
      }
    },

    /** The value captured at take-over (for diagnostics). */
    pending() {
      return previous.captured ? previous.value : undefined;
    },
  };
}
