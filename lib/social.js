/**
 * ソーシャルメディア（X / Instagram / Reddit）の整形。
 *
 * `gsk social <platform> <action>` の生 JSON は 1 回 100〜127 件・数万文字になるため、
 * そのままモデルへ渡すとコンテキストを圧迫して要点が読めない。ここでは
 *   - 先頭 N 件（既定 25）だけを 1 件 3〜4 行の読みやすい形へ落とす
 *   - 投稿 URL を組み立てる（生データに URL が無いものは id から復元できる）
 *   - サーバー側の失敗（`{result: "Failed to execute … action"}`）を日本語で説明する
 * を行う。`raw: true` のときは呼び出し側が整形を飛ばして生 JSON を返す。
 *
 * 実測（gsk 1.15.0 / 2026-10-18）の応答形:
 *   search_posts|get_posts_by_author|… → { results: Row[], pagination: {...} }
 *   search_users|get_users_by_keywords  → { results: [{ id, username, name }] }
 *   get_user                            → { result: { id, username, name, status } }
 *   失敗                                → { result: "Failed to execute Twitter action" }
 *   X の行   : { id, text, author_username, lang, impression_count, created_at_date }
 *   IG の行  : { id, username, full_name, caption, media_type, code_url, like_count, comment_count,
 *                reshare_count, video_play_count, video_duration, created_at_date }
 *   Reddit の行: { id, title, author_username, subreddit_name, created_at_date }
 */

/** 1 回に表示する既定件数（サーバーは limit を無視して 100 件以上返すため、こちらで切る）。 */
export const SOCIAL_DEFAULT_LIMIT = 25;

/** 各プラットフォームのメタ情報（CLI のグループ付きコマンド名を含む）。 */
export const SOCIAL_PLATFORMS = {
  x: {
    label: 'X（Twitter）',
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

/** action の日本語ラベル（見出しに使う）。 */
export const SOCIAL_ACTION_LABELS = {
  search_posts: '投稿検索',
  search_users: 'ユーザー検索',
  get_posts_by_author: '指定ユーザーの投稿',
  get_posts_by_user: '指定ユーザーの投稿',
  get_posts_by_ids: '指定 ID の投稿',
  get_user: 'プロフィール',
  get_user_connections: 'フォロワー / フォロー中',
  get_users_by_keywords: 'キーワードに合うユーザー',
  get_comments: 'コメント',
  get_quotes: '引用投稿',
  get_retweets: 'リツイート',
  get_post_interacting_users: '反応したユーザー',
  count_posts: '該当件数',
  search_comments: 'コメント検索',
  search_subreddits: 'サブレディット検索',
  get_post_with_comments: '投稿とコメント',
  get_subreddit_with_posts: 'サブレディットの投稿',
  get_subreddits_by_keywords: 'キーワードに合うサブレディット',
};

/**
 * action を指定しなかったときの自動判定。
 *
 * - `@handle` / 単独の `handle` 形式で「人」を探していると読める → `get_user`
 * - `from:handle` → その人の投稿（X の検索演算子をそのまま使う）
 * - それ以外 → `search_posts`
 *
 * 迷ったら投稿検索に倒す（ユーザー検索は action を明示すればよい）。
 */
export function autoAction(platform, query) {
  const text = typeof query === 'string' ? query.trim() : '';
  if (text.length === 0) return 'search_posts';
  if (/^@[A-Za-z0-9_.]{1,30}$/.test(text)) return 'get_user';
  if (/^(?:from|user):@?[A-Za-z0-9_.]{1,30}$/i.test(text)) return platform === 'reddit' ? 'search_posts' : 'get_posts_by_author';
  return 'search_posts';
}

/** 検索語・ID を action に合わせて正規化する（@ を落とす等）。 */
export function normalizeSocialArgs(platform, action, args) {
  const out = { ...(args ?? {}) };
  delete out.raw;
  delete out.extra;
  if (typeof out.query === 'string') out.query = out.query.trim();
  if ((action === 'get_user' || action === 'get_posts_by_author' || action === 'get_posts_by_user') && typeof out.query === 'string') {
    // get_user は username（@ なし）を期待する。get_posts_by_author は from: 演算子も通る。
    out.query = out.query.replace(/^user:/i, '').replace(/^from:/i, '').replace(/^@/, '').trim();
  }
  if (action === 'get_user_connections' && typeof out.connection_type !== 'string') out.connection_type = 'followers';
  if (action === 'get_post_interacting_users' && typeof out.interaction_type !== 'string') {
    out.interaction_type = platform === 'instagram' ? 'likers' : 'retweeters';
  }
  return out;
}

/** サーバー側の失敗（`{result: "Failed to execute … action"}`）を日本語へ。 */
export function socialFailure(data) {
  const result = data?.result;
  if (typeof result !== 'string') return undefined;
  if (!/^Failed to execute/i.test(result)) return undefined;
  return (
    `Genspark 側でこの action の実行に失敗しました（${result}）。` +
    'この操作は上流 API の制限で使えないことがあります。' +
    'action を search_posts / search_users / get_user あたりに変えるか、期間（start_date / end_date）を広げて再試行してください。'
  );
}

function collapse(text, limit) {
  const flat = String(text ?? '')
    // 生データは改行が実改行のこともあれば、JSON のエスケープ済み `\n` のこともある（X API は後者）
    .replace(/\\[nrt]/g, ' / ')
    .replace(/\s*\r?\n\s*/g, ' / ')
    .replace(/\s{2,}/g, ' ')
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
  return Number.isFinite(parsed) ? parsed.toLocaleString('ja-JP') : '';
}

/** 行から表示用の 1 行メタ情報を作る。 */
function metaOf(platform, row) {
  const date = formatDate(row?.created_at_date ?? row?.created_at);
  if (platform === 'x') {
    const parts = [row?.author_username ? `@${row.author_username}` : '', date];
    if (number(row?.impression_count) !== '') parts.push(`表示 ${number(row.impression_count)} 回`);
    return parts.filter(Boolean).join(' · ');
  }
  if (platform === 'instagram') {
    const who = row?.username ? `@${row.username}${row?.full_name ? `（${row.full_name}）` : ''}` : '';
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

/** 行から投稿 URL を組み立てる（生データに無い場合は id から復元する）。 */
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

/** 行の本文（投稿なら本文・タイトル・キャプション）。 */
function bodyOf(platform, row) {
  if (platform === 'reddit') return row?.title ?? row?.body ?? row?.text;
  if (platform === 'instagram') return row?.caption ?? row?.text;
  return row?.text ?? row?.full_text ?? row?.title;
}

/** ユーザー行の整形。 */
function formatUser(platform, row) {
  const handle = row?.username ?? row?.screen_name ?? row?.name;
  const label = platform === 'reddit' ? `u/${handle ?? '(不明)'}` : `@${handle ?? '(不明)'}`;
  const name = row?.name ?? row?.full_name;
  const parts = [label];
  if (name && name !== handle) parts.push(`（${name}）`);
  if (row?.id) parts.push(`· id ${row.id}`);
  if (row?.followers_count !== undefined) parts.push(`· フォロワー ${number(row.followers_count)}`);
  return parts.join('');
}

/** 1 行を整形する。 */
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
 * 応答を整形する。
 *
 * @param {unknown} data     gsk の `data`
 * @param {object} options
 * @param {'x'|'instagram'|'reddit'} options.platform
 * @param {string} [options.action]
 * @param {string} [options.query]     見出しに出す検索語
 * @param {number} [options.limit]     表示する最大件数（既定 25）
 */
export function formatSocialResult(data, { platform, action, query, limit } = {}) {
  const meta = SOCIAL_PLATFORMS[platform] ?? { label: platform };
  const actionLabel = SOCIAL_ACTION_LABELS[action] ?? action ?? '';
  const failure = socialFailure(data);
  if (failure !== undefined) return `${meta.label}: ${failure}`;

  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : SOCIAL_DEFAULT_LIMIT;
  const head = `${meta.label}${actionLabel ? `の${actionLabel}` : ''}${query ? `: 「${query}」` : ''}`;

  // 配列（results / tweets / posts）を優先し、無ければ単体の result を見る。
  let rows;
  for (const key of ['results', 'tweets', 'posts', 'items', 'data']) {
    if (Array.isArray(data?.[key])) {
      rows = data[key];
      break;
    }
  }
  if (rows === undefined && data?.result !== undefined) {
    const result = data.result;
    rows = Array.isArray(result) ? result : [result];
  }
  if (rows === undefined && data !== null && typeof data === 'object') {
    const keys = Object.keys(data);
    // get_user のように `{result:{...}}` ではなく素の 1 オブジェクトを返す形にも対応する
    if (keys.length > 0 && !keys.includes('pagination')) rows = [data];
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return `${head}: 該当する結果はありませんでした。\n（応答: ${JSON.stringify(data)?.slice(0, 300) ?? 'なし'}）`;
  }

  const total = rows.length;
  const shown = rows.slice(0, max);
  const lines = [`${head} — ${total} 件${total > shown.length ? `中 先頭 ${shown.length} 件` : ''}`];
  for (const [index, row] of shown.entries()) lines.push(formatRow(platform, action, row, index + 1));
  if (total > shown.length) {
    lines.push(`… 他 ${total - shown.length} 件（件数を増やすには limit、生データは raw: true）`);
  }
  const pagination = data?.pagination;
  if (pagination && typeof pagination === 'object' && Number(pagination.total_rows) > 0) {
    lines.push(`（サーバー申告: ${pagination.total_rows} 件 / ${pagination.total_pages} ページ）`);
  }
  return lines.join('\n');
}
