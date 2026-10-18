/**
 * Formatting for social media (X / Instagram / Reddit).
 *
 * The raw JSON of `gsk social <platform> <action>` is 100–127 items and tens of thousands of characters
 * per call, so passing it to the model as-is floods the context and makes the key points unreadable.
 * This module:
 *   - reduces the first N items (25 by default) to a readable 3–4 lines each
 *   - builds post URLs (items without a URL in the raw data can be reconstructed from the id)
 *   - explains server-side failures (`{result: "Failed to execute … action"}`) in plain English
 * When `raw: true`, the caller skips formatting and returns the raw JSON.
 *
 * Response shapes measured with gsk 1.15.0 / 2026-10-18:
 *   search_posts|get_posts_by_author|… → { results: Row[], pagination: {...} }
 *   search_users|get_users_by_keywords  → { results: [{ id, username, name }] }
 *   get_user                            → { result: { id, username, name, status } }
 *   Reddit get_post_with_comments       → { result: { post: Row, comments: Row[] } }
 *   Reddit get_subreddit_with_posts     → { result: { subreddit: {...}, posts: Row[] } }
 *   failure                             → { result: "Failed to execute Twitter action" }
 *   X row    : { id, text, author_username, lang, impression_count, created_at_date }
 *   IG row   : { id, username, full_name, caption, media_type, code_url, like_count, comment_count,
 *                reshare_count, video_play_count, video_duration, created_at_date }
 *   Reddit row: { id, title, author_username, subreddit_name, created_at_date }
 */

/** Default number of items to show per call (the server ignores limit and returns 100+ items, so we truncate here). */
export const SOCIAL_DEFAULT_LIMIT = 25;

/** Metadata for each platform (including the CLI's grouped command name). */
export const SOCIAL_PLATFORMS = {
  x: {
    label: 'X (Twitter)',
    gsk: 'social_twitter',
    command: ['social', 'twitter'],
    actions: [
      'search_posts',
      'search_users',
      'get_posts_by_author',
      'get_posts_by_ids',
      'get_user',
      'get_user_connections',
      'get_users_by_keywords',
      'get_comments',
      'get_quotes',
      'get_retweets',
      'get_post_interacting_users',
      'count_posts',
    ],
  },
  instagram: {
    label: 'Instagram',
    gsk: 'social_instagram',
    command: ['social', 'instagram'],
    actions: [
      'search_posts',
      'search_users',
      'get_posts_by_user',
      'get_posts_by_ids',
      'get_user',
      'get_user_connections',
      'get_users_by_keywords',
      'get_comments',
      'get_post_interacting_users',
    ],
  },
  reddit: {
    label: 'Reddit',
    gsk: 'social_reddit',
    command: ['social', 'reddit'],
    actions: [
      'search_posts',
      'search_comments',
      'search_users',
      'search_subreddits',
      'get_post_with_comments',
      'get_subreddit_with_posts',
      'get_subreddits_by_keywords',
      'get_user',
      'get_users_by_keywords',
    ],
  },
};

/** Labels for actions (used in headings). */
export const SOCIAL_ACTION_LABELS = {
  search_posts: 'post search',
  search_users: 'user search',
  get_posts_by_author: 'posts by user',
  get_posts_by_user: 'posts by user',
  get_posts_by_ids: 'posts by ID',
  get_user: 'account info',
  get_user_connections: 'followers / following',
  get_users_by_keywords: 'users matching keywords',
  get_comments: 'comments',
  get_quotes: 'quote posts',
  get_retweets: 'retweets',
  get_post_interacting_users: 'users who reacted',
  count_posts: 'matching post count',
  search_comments: 'comment search',
  search_subreddits: 'subreddit search',
  get_post_with_comments: 'post and comments',
  get_subreddit_with_posts: 'subreddit posts',
  get_subreddits_by_keywords: 'subreddits matching keywords',
};

/**
 * Automatic action selection when action is not specified.
 *
 * - A `@handle` form that reads as looking for a "person" → that user's posts (X / Instagram).
 *   `get_user` returns only id / username / name and is unsuitable for research, so it is not used
 *   (Reddit uses `get_user` only because it has no post-list action).
 * - `from:handle` / `user:handle` → that user's posts (using X's search operators as-is)
 * - Otherwise → `search_posts`
 *
 * When in doubt, fall back to post search (account information can be obtained by specifying the action explicitly).
 */
export function autoAction(platform, query) {
  const text = typeof query === 'string' ? query.trim() : '';
  if (text.length === 0) return 'search_posts';
  if (/^(?:from|user):@?[A-Za-z0-9_.]{1,30}$/i.test(text)) {
    if (platform === 'x') return 'get_posts_by_author';
    if (platform === 'instagram') return 'get_posts_by_user';
    return 'search_posts';
  }
  if (/^@[A-Za-z0-9_.]{1,30}$/.test(text)) {
    if (platform === 'x') return 'get_posts_by_author';
    if (platform === 'instagram') return 'get_posts_by_user';
    return 'get_user';
  }
  return 'search_posts';
}

/** Normalize the query/ID for the action (e.g. strip the leading @). */
export function normalizeSocialArgs(platform, action, args) {
  const out = { ...(args ?? {}) };
  delete out.raw;
  delete out.extra;
  if (typeof out.query === 'string') out.query = out.query.trim();
  if ((action === 'get_user' || action === 'get_posts_by_author' || action === 'get_posts_by_user') && typeof out.query === 'string') {
    // get_user expects a username (without @). get_posts_by_author also accepts the from: operator.
    out.query = out.query.replace(/^user:/i, '').replace(/^from:/i, '').replace(/^@/, '').trim();
  }
  if (action === 'get_user_connections' && typeof out.connection_type !== 'string') out.connection_type = 'followers';
  if (action === 'get_post_interacting_users' && typeof out.interaction_type !== 'string') {
    out.interaction_type = platform === 'instagram' ? 'likers' : 'retweeters';
  }
  return out;
}

/** Convert server-side failures (`{result: "Failed to execute … action"}`) into English. */
export function socialFailure(data) {
  const result = data?.result;
  if (typeof result !== 'string') return undefined;
  if (!/^Failed to execute/i.test(result)) return undefined;
  return (
    `the Genspark server could not run this action (result: "${result}"). ` +
    'In our measurements, this appears not only for unsupported actions but also for **transient failures (such as rate limits)**. ' +
    'The same arguments may succeed after a few tens of seconds, so wait a moment and retry once' +
    ' (the plugin has already retried once automatically). If it still fails, try ' +
    'changing the action to search_posts / search_users / get_user, removing the date range (start_date / end_date), ' +
    'or narrowing the query to 1–2 words.'
  );
}

/** `1 item` / `2 items` */
function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function collapse(text, limit) {
  const flat = String(text ?? '')
    // Raw data may contain literal newlines or JSON-escaped `\n` (the X API uses the latter)
    .replace(/\\[nrt]/g, ' / ')
    .replace(/\s*\r?\n\s*/g, ' / ')
    .replace(/\s{2,}/g, ' ')
    // Consecutive newlines become " /  / ", so collapse them into one
    .replace(/(?: \/ ){2,}/g, ' / ')
    .trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit)}…`;
}

function formatDate(value) {
  const text = String(value ?? '');
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match === null ? '' : `${match[1]}-${match[2]}-${match[3]}`;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString('en-US') : '';
}

/** Build the one-line display metadata for a row. */
function metaOf(platform, row) {
  const date = formatDate(row?.created_at_date ?? row?.created_at);
  if (platform === 'x') {
    const parts = [row?.author_username ? `@${row.author_username}` : '', date];
    if (number(row?.impression_count) !== '') parts.push(`${number(row.impression_count)} impressions`);
    return parts.filter(Boolean).join(' · ');
  }
  if (platform === 'instagram') {
    const who = row?.username ? `@${row.username}${row?.full_name ? ` (${row.full_name})` : ''}` : '';
    const parts = [who, date];
    const stats = [];
    if (row?.like_count !== undefined) stats.push(`♥ ${number(row.like_count)}`);
    if (row?.comment_count !== undefined) stats.push(`💬 ${number(row.comment_count)}`);
    if (Number(row?.video_play_count) > 0) stats.push(`▶ ${number(row.video_play_count)}`);
    if (stats.length > 0) parts.push(stats.join(' '));
    if (row?.media_type) parts.push(String(row.media_type));
    return parts.filter(Boolean).join(' · ');
  }
  const parts = [
    row?.subreddit_name ? `r/${row.subreddit_name}` : '',
    row?.author_username ? `u/${row.author_username}` : '',
    date,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Build the post URL for a row (reconstruct it from the id when the raw data has none). */
export function postUrlOf(platform, row) {
  const explicit = row?.url ?? row?.code_url ?? row?.permalink;
  if (typeof explicit === 'string' && /^https?:\/\//.test(explicit)) return explicit;
  const id = row?.id ?? row?.post_id;
  if (typeof id !== 'string' || id.length === 0) return undefined;
  if (platform === 'x') {
    const author = row?.author_username;
    return typeof author === 'string' && author.length > 0 ? `https://x.com/${author}/status/${id}` : undefined;
  }
  if (platform === 'reddit') {
    const sub = row?.subreddit_name;
    return typeof sub === 'string' && sub.length > 0
      ? `https://www.reddit.com/r/${sub}/comments/${id}`
      : `https://www.reddit.com/comments/${id}`;
  }
  return undefined;
}

/** Row body (for posts: text, title, or caption). */
function bodyOf(platform, row) {
  if (platform === 'reddit') return row?.title ?? row?.body ?? row?.text;
  if (platform === 'instagram') return row?.caption ?? row?.text;
  return row?.text ?? row?.full_text ?? row?.title;
}

/** Format a user row. */
function formatUser(platform, row) {
  const handle = row?.username ?? row?.screen_name ?? row?.name;
  const label = platform === 'reddit' ? `u/${handle ?? '(unknown)'}` : `@${handle ?? '(unknown)'}`;
  const name = row?.name ?? row?.full_name;
  const parts = [label];
  if (name && name !== handle) parts.push(` (${name})`);
  if (row?.id) parts.push(` · id ${row.id}`);
  if (row?.followers_count !== undefined) parts.push(` · followers ${number(row.followers_count)}`);
  return parts.join('');
}

/** Format a single row. */
function formatRow(platform, action, row, index) {
  if (row === null || typeof row !== 'object') return `${index}. ${String(row)}`;
  const isUserAction =
    action === 'search_users' ||
    action === 'get_user' ||
    action === 'get_users_by_keywords' ||
    action === 'get_user_connections' ||
    action === 'get_post_interacting_users' ||
    action === 'search_subreddits' ||
    action === 'get_subreddits_by_keywords';
  if (isUserAction && (row.username || row.name) && row.text === undefined && row.title === undefined) {
    return `${index}. ${formatUser(platform, row)}`;
  }
  const body = collapse(bodyOf(platform, row), 280);
  const meta = metaOf(platform, row);
  const url = postUrlOf(platform, row);
  const lines = [`${index}. ${meta}`];
  if (body.length > 0) lines.push(`   ${body}`);
  if (url !== undefined) lines.push(`   ${url}`);
  return lines.join('\n');
}

/**
 * Strip the single `{ result: {...} }` wrapper.
 *
 * Reddit's `get_post_with_comments` / `get_subreddit_with_posts` return
 * `{result:{post,comments}}` / `{result:{subreddit,posts}}`, so leaving the wrapper in place
 * formats "a mysterious one-line object" and produces an empty line (measured).
 */
export function unwrapSocialData(data) {
  let current = data;
  for (let depth = 0; depth < 2; depth += 1) {
    if (
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      current.result !== null &&
      typeof current.result === 'object' &&
      !Array.isArray(current.result)
    ) {
      current = current.result;
      continue;
    }
    break;
  }
  return current;
}

/** Get a comparable timestamp from `created_at_date` (undefined if absent). */
function dateValue(row) {
  const text = String(row?.created_at_date ?? row?.created_at ?? '');
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Sort newest first (because `get_posts_by_author` does not return rows in chronological order — measured).
 * Rows whose date cannot be parsed keep their original order and are moved to the end.
 */
export function sortByDateDesc(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return rows ?? [];
  const dated = [];
  const undated = [];
  for (const row of rows) (dateValue(row) === undefined ? undated : dated).push(row);
  if (dated.length < 2) return rows;
  dated.sort((a, b) => dateValue(b) - dateValue(a));
  return [...dated, ...undated];
}

/** Format a post with its comments (Reddit `get_post_with_comments`). */
function formatPostWithComments(platform, data, max) {
  const post = data.post ?? {};
  const comments = Array.isArray(data.comments) ? data.comments : [];
  const title = collapse(post.title ?? post.text ?? '(no title)', 300);
  const head = `${SOCIAL_PLATFORMS[platform]?.label ?? platform} post and comments: "${collapse(post.title ?? post.id ?? '', 80)}"`;
  const lines = [head, `1. ${metaOf(platform, post)}`, `   ${title}`];
  const url = postUrlOf(platform, post);
  if (url !== undefined) lines.push(`   ${url}`);
  if (comments.length === 0) {
    lines.push('Comments: 0 (the upstream API often returns none in our measurements)');
    return lines.join('\n');
  }
  const shown = comments.slice(0, max);
  lines.push(`Comments: ${plural(comments.length, 'item')}${comments.length > shown.length ? ` (showing first ${shown.length})` : ''}`);
  for (const [index, comment] of shown.entries()) {
    const who = comment.author_username
      ? platform === 'reddit'
        ? `u/${comment.author_username}`
        : `@${comment.author_username}`
      : '';
    const date = formatDate(comment.created_at_date);
    const meta = [who, date].filter(Boolean).join(' · ');
    const body = collapse(comment.body ?? comment.text ?? '', 200);
    const suffix = platform === 'reddit' && comment.score !== undefined ? ` (+${number(comment.score)})` : '';
    lines.push(`${index + 1}. ${meta}${suffix}${body.length > 0 ? ` — ${body}` : ''}`);
  }
  if (comments.length > shown.length) lines.push(`… ${plural(comments.length - shown.length, 'more comment')}`);
  return lines.join('\n');
}

/** Format a subreddit with its posts (Reddit `get_subreddit_with_posts`). */
function formatSubredditWithPosts(platform, data, max) {
  const subreddit = data.subreddit ?? {};
  const posts = sortByDateDesc(Array.isArray(data.posts) ? data.posts : []);
  const name = subreddit.display_name ?? subreddit.name ?? '?';
  const subscribers = Number(subreddit.subscribers_count);
  const head =
    `${SOCIAL_PLATFORMS[platform]?.label ?? platform} subreddit: r/${name}` +
    (Number.isFinite(subscribers) && subscribers > 0 ? ` (${number(subscribers)} subscribers)` : '');
  const lines = [head];
  if (posts.length === 0) {
    lines.push('Posts: 0');
    return lines.join('\n');
  }
  const shown = posts.slice(0, max);
  lines.push(`Posts: ${plural(posts.length, 'item')}${posts.length > shown.length ? ` (showing first ${shown.length}, newest first)` : ' (newest first)'}`);
  for (const [index, post] of shown.entries()) lines.push(formatRow(platform, 'search_posts', post, index + 1));
  if (posts.length > shown.length) lines.push(`… ${plural(posts.length - shown.length, 'more post')}`);
  return lines.join('\n');
}

/**
 * Format a response.
 *
 * @param {unknown} data     gsk `data`
 * @param {object} options
 * @param {'x'|'instagram'|'reddit'} options.platform
 * @param {string} [options.action]
 * @param {string} [options.query]     query to show in the heading
 * @param {number} [options.limit]     maximum number of items to show (default 25)
 * @param {string} [options.language]  narrow by language (only when rows have lang)
 */
export function formatSocialResult(data, options = {}) {
  const { platform, action, query, limit, language } = options;
  const meta = SOCIAL_PLATFORMS[platform] ?? { label: platform };
  const actionLabel = SOCIAL_ACTION_LABELS[action] ?? action ?? '';
  const failure = socialFailure(data);
  if (failure !== undefined) return `${meta.label} — ${failure}`;

  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : SOCIAL_DEFAULT_LIMIT;
  const head = `${meta.label}${actionLabel ? ` ${actionLabel}` : ''}${query ? `: "${query}"` : ''}`;

  const body = unwrapSocialData(data);

  // The two Reddit actions return dedicated nested objects instead of results
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    if (body.post !== undefined && (Array.isArray(body.comments) || Array.isArray(body.posts))) {
      return formatPostWithComments(platform, body, max);
    }
    if (body.subreddit !== undefined && Array.isArray(body.posts)) {
      return formatSubredditWithPosts(platform, body, max);
    }
  }

  // Prefer arrays (results / tweets / posts); otherwise look at a bare array or a single object.
  let rows;
  for (const key of ['results', 'tweets', 'posts', 'items', 'data', 'comments', 'users', 'subreddits']) {
    const value = body?.[key];
    if (Array.isArray(value)) {
      rows = value;
      break;
    }
  }
  if (rows === undefined && Array.isArray(body?.result)) rows = body.result;
  if (rows === undefined && Array.isArray(body)) rows = body;
  if (rows === undefined && body !== null && typeof body === 'object') {
    const keys = Object.keys(body);
    // Also handle shapes that return a single bare object, such as get_user
    if (keys.length > 0 && !keys.includes('pagination')) rows = [body];
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return (
      `${head} — no matching results (the server returned 0 items).\n` +
      'Try narrowing the query to 1–2 words / widening the date range (start_date, end_date) / changing the action.'
    );
  }

  // Order post-like results newest first (some actions do not return rows in chronological order)
  const ordered = action === 'get_comments' || action === 'search_comments' ? rows : sortByDateDesc(rows);
  // When language is specified, narrow to matching rows only if rows carry lang (do not filter when nothing matches, to avoid dropping results)
  let selected = ordered;
  let langNote = '';
  const lang = typeof language === 'string' ? language.trim().toLowerCase() : '';
  if (lang.length > 0) {
    const tagged = ordered.filter((row) => typeof row?.lang === 'string' && row.lang.length > 0);
    if (tagged.length > 0) {
      const matched = tagged.filter((row) => row.lang.toLowerCase().startsWith(lang));
      if (matched.length > 0 && matched.length < ordered.length) {
        selected = matched;
        langNote = ` · narrowed to ${matched.length} of ${plural(tagged.length, 'item')} with language="${lang}"`;
      }
    }
  }
  const total = selected.length;
  const shown = selected.slice(0, max);
  const lines = [`${head} — ${plural(total, 'result')}${total > shown.length ? ` (showing first ${shown.length})` : ''}${langNote}`];
  for (const [index, row] of shown.entries()) lines.push(formatRow(platform, action, row, index + 1));
  if (total > shown.length) {
    lines.push(
      `… showing ${shown.length} of ${plural(total, 'item')} returned by the server (${total - shown.length} remaining). ` +
        'Increase with limit / use raw: true for all raw data',
    );
  }
  const pagination = data?.pagination ?? data?.posts_pagination;
  if (pagination && typeof pagination === 'object' && Number(pagination.total_rows) > 0) {
    lines.push(`(server-reported: ${plural(pagination.total_rows, 'item')} / ${pagination.total_pages} pages)`);
  }
  return lines.join('\n');
}
