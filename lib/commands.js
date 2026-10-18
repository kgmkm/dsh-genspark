/**
 * dsh-genspark — ホストコマンド（コンポーザの `+` メニューと `/` から呼べる行）。
 *
 * なぜコマンドなのか:
 *   コマンドは**モデルメッセージを作らない**。結果テキストは UI がモデル履歴の外に描画するため、
 *   モデルのコンテキストを消費せずに Genspark を使える。`+` メニューに並ぶ価値はここにある
 *   （調べ物・生成の「人間向けの入口」を、会話履歴を汚さずに持てる）。
 *
 * 設計上の約束:
 *   - 実行経路は昇格ツールと同一（runner.runTool → gsk <tool> --args-file …）。引数の検証も
 *     昇格ツールと同じ build() を通すので、引数名の食い違いは CLI 起動前に日本語で返る。
 *   - コマンドには承認（approve_write）の仕組みが無いため、副作用のある操作は常に `--no-input`
 *     （＝サーバー呼び出し前に拒否）で実行する。書き込みが必要な操作は genspark_run ツールから行う。
 *   - 生成メディアのコマンドは成果物を <セッション cwd>/genspark-out/ に自動保存し、パスを表示する。
 *     `-o` は拡張子を検証しない（実測）ため、拡張子は慣例に合わせた見た目上のものである。
 *   - 名前は genspark 接頭辞で統一する。ホストの既存コマンド（compact / model / permission /
 *     export / feedback / goal / plan）と衝突させない。名前は /^[a-z][a-z0-9_-]*$/ に一致する必要がある。
 *   - どのコマンドを出すかは設定 promotedCategories に従う（search / media を無効にすれば
 *     そのカテゴリのコマンドも消える）。genspark / genspark-tools / genspark-run は常時。
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { ENTRY_NOT_FOUND_MESSAGE } from './gsk-cli.js';
import { describeToolFull, filterTools, summarizeCatalog } from './catalog.js';
import { collectModels, formatModelList, kindOfInput } from './models.js';
import { describeSavedFile, PROMOTED_TOOLS, promotedSummary, resolvePromotedCategories } from './promoted.js';
import { describeRun, parseEnvelope, truncate } from './result.js';

/** gsk ツール名 → 昇格ツール定義。 */
const SPEC_BY_GSK = new Map(PROMOTED_TOOLS.map((spec) => [spec.gsk, spec]));

/**
 * CLI 内蔵コマンド（カタログに載らない）のうち、/genspark-run から実行を許すもの。
 * `me` はアカウントと残クレジットを返す読み取り専用コマンド（実測でカタログに存在しない）。
 * 書き込みを伴う内蔵コマンド（init-skills / login など）は許可しない。
 */
const CLI_BUILTIN_READONLY = new Set(['me']);

/** 一覧表示でタイトル・URL・本文として拾うキー（ツールごとに名前が違うため候補を並べる）。 */
const TITLE_KEYS = ['title', 'name', 'model_name', 'place_name', 'headline', 'label', 'query'];
const URL_KEYS = ['url', 'link', 'source_url', 'image_url', 'thumbnail_url', 'video_url', 'place_id', 'id'];
const TEXT_KEYS = ['snippet', 'description', 'summary', 'address', 'text', 'content'];
const LIST_KEYS = [
  'organic_results', 'results', 'images', 'local_results', 'places', 'items', 'entries',
  'documents', 'videos', 'papers', 'models', 'data', 'output',
];

/** invocation からセッションの作業ディレクトリを取る。 */
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
 * 項目から文字列を拾う。見つからなければネストしたオブジェクトを 1 段だけ覗く
 * （例: get_model_info は { model_name, model_info: { name, capabilities, … } } を返す）。
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

/** 項目（とネストしたオブジェクト）が持つ「文字列の配列」を `key: a / b / c` の形で集める。 */
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

/** data の中から「一覧らしい配列」を 1 つ探す。 */
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
 * API の data を人間が読みやすい一覧へ整形する。
 * 一覧が見つからない場合は null を返し、呼び出し側が JSON 表示へフォールバックする。
 */
export function humanizeData(data, { limit = 5, maxChars = 4000 } = {}) {
  const found = findList(data);
  if (found === null) return null;
  const shown = Math.min(limit, found.list.length);
  const lines = [`${found.key || 'items'}: ${found.list.length} 件（先頭 ${shown} 件を表示）`];
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
      // 拾える項目が無いときは JSON をそのまま 1 行で見せる（例: 未知のスキーマを返すツール）
      lines.push(`${index + 1}. ${truncate(JSON.stringify(entry), 300).text}`);
      return;
    }
    lines.push(`${index + 1}. ${title || '(タイトルなし)'}`);
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
 * 結果が「本文そのもの」であるツール（一覧整形すると本文が消えるため、described をそのまま出す）。
 * 例: understand_images の data は { results:[{url, result}] } で、一覧整形では result が落ちる。
 */
const TEXTUAL_TOOLS = new Set(['understand_images', 'analyze_media', 'audio_transcribe', 'summarize_large_document']);

/** 実行結果をコマンドの戻り値（CommandResult）へ落とす。 */
function reportRun(tool, result, built, cfg, log) {
  const described = describeRun(result, { tool, maxChars: Number(cfg.maxOutputChars ?? 100000) });
  if (cfg.debug && typeof result.stderr === 'string' && result.stderr.trim().length > 0) {
    log?.(`[genspark] ${tool} stderr: ${result.stderr.trim().slice(0, 500)}`);
  }
  if (!described.ok) return { kind: 'error', text: described.text };
  const { value } = parseEnvelope(result.stdout);
  const human = TEXTUAL_TOOLS.has(tool) ? null : humanizeData(value?.data);
  let text = human ?? described.text;
  if (built?.saveTo) text += `\n${describeSavedFile(built.saveTo)}`;
  return { kind: 'success', text: `${text}\n（tool: ${tool}）` };
}

/** 生成メディアの自動保存先（<cwd>/genspark-out/<日時>-<種別>[-<slug>].<ext>）。 */
export function autoSavePath(cwd, kind, input, extension) {
  const dir = join(cwd, 'genspark-out');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 作れない場合は CLI 側の保存エラーとして表面化する */
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
 * 先頭トークンを url、残りを question として解釈する（question 省略時は既定の質問）。
 * 添付ファイルがあれば、その先頭を対象にして入力全体を質問として扱う。
 */
function splitUrlAndQuestion(input, files = []) {
  const text = String(input ?? '').trim();
  const question = text.length > 0 ? text : 'この文書の要点を日本語で簡潔にまとめてください。';
  if (files.length > 0) return { url: files[0], question };
  const match = /^(\S+)\s*([\s\S]*)$/.exec(text);
  const url = match?.[1] ?? text;
  const rawQuestion = (match?.[2] ?? '').trim();
  return { url, question: rawQuestion.length > 0 ? rawQuestion : 'この文書の要点を日本語で簡潔にまとめてください。' };
}

/**
 * 先頭トークンを media パス、残りを指示として解釈する（指示省略時は日本語で説明）。
 * 添付ファイルがあれば、それを対象にして入力全体を指示として扱う。
 */
function splitMediaAndInstruction(input, files = []) {
  const text = String(input ?? '').trim();
  const instruction = text.length > 0 ? text : 'このメディアの内容を日本語で詳しく説明してください。';
  if (files.length > 0) return { media_list: files, instruction };
  const match = /^(\S+)\s*([\s\S]*)$/.exec(text);
  const media = match?.[1] ?? text;
  const rawInstruction = (match?.[2] ?? '').trim();
  return {
    media,
    instruction: rawInstruction.length > 0 ? rawInstruction : 'このメディアの内容を日本語で詳しく説明してください。',
  };
}

// ── 添付ファイル（コンポーザの画像・ファイル）の受け取り ─────────────────────────
//
// ホストの dsh-commands は、コマンドが `input.attachments = true` を宣言しない限り
// 添付付きの実行を **ハンドラ起動前に** 拒否する（`<name> does not accept attachments`）。
// 一方、宣言したコマンドには `invocation.attachments` として
//   { type: 'image', attachment: ImageAttachmentRef } / { type: 'file', attachment: FileAttachmentRef }
// が選択順で渡る。ここではそれを **gsk に渡せるローカルパス** へ解決する。
// gsk は子プロセスなので、ホスト側の実パスをそのまま渡せば自動アップロードされる
// （プラグイン自身はファイルを読まないため、サンドボックスの影響も受けない）。

/** 画像 mediaType → 拡張子（どうしてもパスが取れないときだけ使う）。 */
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

/** 添付ブロックの参照からホスト上の実パスを得る（実装差があるため複数の API を試す）。 */
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

/** 添付ブロックの実体を読む（パスが取れないバックエンド向けの保険）。 */
async function readAttachmentBytes(store, block) {
  const ref = block?.attachment;
  if (typeof store?.readImage === 'function' && block?.type === 'image') {
    try {
      const stored = await store.readImage(ref);
      const data = stored?.data ?? stored?.bytes;
      if (data !== undefined && data !== null) return Buffer.from(data);
    } catch {
      /* 次の手段へ */
    }
  }
  if (typeof store?.readFileStream === 'function') {
    try {
      const chunks = [];
      for await (const chunk of store.readFileStream(ref)) chunks.push(Buffer.from(chunk));
      if (chunks.length > 0) return Buffer.concat(chunks);
    } catch {
      /* 次の手段へ */
    }
  }
  return undefined;
}

/** 添付に付ける拡張子（名前 → mediaType → 空）。 */
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
 * invocation.attachments を gsk へ渡せるローカルパスの配列へ解決する。
 * 添付が無ければ空配列。解決できない場合は日本語で throw する（CLI は起動しない）。
 */
export async function resolveAttachmentFiles(invocation, deps) {
  const list = Array.isArray(invocation?.attachments) ? invocation.attachments : [];
  if (list.length === 0) return [];
  // プラグインの ctx（index.js が注入する）を優先し、無ければ agent 側の ctx を見る
  let store;
  for (const candidate of [deps?.ctx, commandCtx(invocation)]) {
    store = getService(candidate, 'attachments');
    if (store !== undefined) break;
  }
  if (store === undefined) {
    throw new Error(
      '添付ファイルを読み取れません（このプロファイルに attachments サービスがありません）。' +
        'ファイルのパスを文字で入力する方法に切り替えてください。',
    );
  }
  const cwd = commandCwd(invocation);
  const files = [];
  for (const [index, block] of list.entries()) {
    const hostPath = hostPathOf(store, block);
    if (hostPath !== undefined) {
      // 実ストアの画像は拡張子なしの content-addressed パス（<root>/objects/xx/<sha256>）を返す。
      // gsk は拡張子で種別を判断するため、拡張子が無いものだけ genspark-out/attachments へ複製する。
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
        /* 複製時に表面化する */
      }
      const target = join(dir, `${basename(hostPath).slice(0, 16)}-${index}${ext}`);
      copyFileSync(hostPath, target);
      files.push(target);
      continue;
    }
    const bytes = await readAttachmentBytes(store, block);
    if (bytes === undefined) {
      throw new Error(
        '添付ファイルの実体を取得できませんでした（ホストがパスもバイト列も返しません）。' +
          'ファイルのパスを文字で入力してください。',
      );
    }
    const dir = join(cwd, 'genspark-out', 'attachments');
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* 書き込み時に表面化する */
    }
    const target = join(dir, `${Date.now()}-${index}${extensionOf(block)}`);
    writeFileSync(target, bytes);
    files.push(target);
  }
  return files;
}

/**
 * 昇格ツール 1 つに対応するコマンド定義（genspark-* → gsk ツール）。
 * hint は入力欄のヒント、toArgs は入力文字列を Genspark の引数へ変換する関数。
 */
const PROMOTED_COMMANDS = [
  {
    name: 'genspark-search',
    gsk: 'web_search',
    hint: '検索クエリ（例: DeepSeek Harness の最新情報）',
    description: 'Web 検索を実行して結果を表示します（会話履歴は消費しません）',
    toArgs: (input) => ({ q: input }),
  },
  {
    name: 'genspark-image-search',
    gsk: 'image_search',
    hint: '画像の検索語（英語が安定）',
    description: '画像を検索して URL を一覧します',
    toArgs: (input) => ({ query: input }),
  },
  {
    name: 'genspark-crawl',
    gsk: 'crawler',
    hint: '<URL かローカルファイルのパス>',
    description: 'Web ページ / PDF の本文を取得します',
    attachments: true,
    toArgs: (input, _cwd, files) => ({ url: files.length > 0 ? files[0] : input }),
  },
  {
    name: 'genspark-scholar',
    gsk: 'scholar_search',
    hint: '論文の検索語（例: diffusion model for speech synthesis）',
    description: '学術論文を検索します（タイトル・著者・被引用数）',
    toArgs: (input) => ({ query: input }),
  },
  {
    name: 'genspark-maps',
    gsk: 'maps_search',
    hint: '場所の問い（例: 東京駅周辺のカフェ）',
    description: '地図・場所を検索します（経路は genspark_run の maps_search で engine=maps_directions）',
    toArgs: (input) => ({ query_type: 'search', engine: 'maps', query: input }),
  },
  {
    name: 'genspark-summarize',
    gsk: 'summarize_large_document',
    hint: '<URL かローカルパス> [質問]（添付ファイルも可。質問を省くと要点をまとめます）',
    description: '長い文書を読ませて質問に答えます（PDF / Office / Web ページ）',
    attachments: true,
    toArgs: (input, _cwd, files) => splitUrlAndQuestion(input, files),
  },
  {
    name: 'genspark-image',
    gsk: 'image_generation',
    hint: '生成したい画像の説明（英語推奨。添付画像を渡すと編集・リスタイル）',
    description: '画像を生成して genspark-out/ に保存します（クレジットを消費します）',
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
    hint: '生成したい動画の説明（英語。添付画像を先頭フレームにできます）',
    description: '動画を生成して保存します（クレジットを消費・数分かかります・既定は無音）',
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
    hint: '読み上げ原稿、または生成したい音の説明',
    description: '音声（読み上げ・効果音・音楽）を生成して保存します（クレジットを消費します）',
    toArgs: (input, cwd) => ({ prompt: input, save_to: autoSavePath(cwd, 'audio', input, 'mp3') }),
  },
  {
    name: 'genspark-analyze-media',
    gsk: 'understand_images',
    hint: '<画像/動画/音声のパス or URL> [指示]（添付ファイルも可。省略時は内容を日本語で説明）',
    description: 'メディア（画像・動画・音声）の内容を理解して説明します（既定の汎用モデル）',
    attachments: true,
    toArgs: (input, _cwd, files) => splitMediaAndInstruction(input, files),
  },
];

const USAGE_TOOLS = 'キーワードを付けると絞り込みます（例: /genspark-tools slack send）。空ならグループ一覧。';
const USAGE_RUN =
  '使い方: /genspark-run <ツール名> [JSON引数]\n例: /genspark-run web_search {"q":"DeepSeek Harness"}\n' +
  'ツール名は /genspark-tools で探せます。副作用のある操作は実行できません（genspark_run ツールを使う）。';

/** コマンド一覧の使い方テキスト。 */
function usageLines(commands) {
  const lines = ['使えるコマンド:'];
  for (const command of commands) {
    const hint = command.input?.hint ? ` ${command.input.hint}` : '';
    lines.push(`  /${command.name}${hint}`);
    lines.push(`      ${command.description}`);
  }
  return lines;
}

/** /genspark — 接続状態・アカウント・残クレジット・ツール数。 */
async function runStatus(invocation, deps, getCommands) {
  const cfg = deps.getConfig();
  const cwd = commandCwd(invocation);
  const signal = invocation?.signal;
  const lines = [];

  const entry = deps.runner.resolveEntry();
  if (entry === null) return { kind: 'error', text: ENTRY_NOT_FOUND_MESSAGE };
  lines.push(`CLI エントリ: ${entry}`);
  try {
    const runtime = deps.runner.resolveRuntime?.();
    if (runtime) lines.push(`実行ランタイム: ${runtime.path}（${runtime.source}）`);
  } catch {
    /* ランタイム解決に失敗しても状態表示は続ける */
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
    lines.push(`アカウント: 取得できませんでした（${error?.message ?? String(error)}）`);
  }
  if (me !== null) {
    const { value } = parseEnvelope(me.stdout);
    if (value?.status === 'ok') {
      const data = value.data ?? {};
      const name = typeof data.name === 'string' && data.name.length > 0 ? `（${data.name}）` : '';
      lines.push(`アカウント: ${data.email ?? '(不明)'}${name} / plan ${data.plan ?? '不明'}`);
      if (data.credit_balance !== undefined) lines.push(`残クレジット: ${data.credit_balance}`);
    } else {
      const described = describeRun(me, { tool: 'me' });
      lines.push(`アカウント: 取得できませんでした — ${described.text.split('\n')[0]}`);
    }
  }

  try {
    const catalog = await deps.catalog.load(deps.runner, { cwd, signal });
    lines.push(`ツール: ${catalog.tools.length} 件`);
  } catch (error) {
    lines.push(`ツール: カタログを取得できませんでした（${String(error?.message ?? error).split('\n')[0]}）`);
  }

  lines.push(`昇格ツール: ${promotedSummary(cfg.promotedCategories)}`);
  lines.push(`writeMode: ${cfg.writeMode}`);
  lines.push('');
  lines.push(...usageLines(getCommands()));
  return { kind: 'success', text: lines.join('\n') };
}

/** /genspark-tools — カタログ検索（1 件に絞れたら引数の完全スキーマを表示）。 */
async function runTools(invocation, deps) {
  const cwd = commandCwd(invocation);
  const raw = String(invocation?.rawInput ?? '').trim();
  const refresh = /^--refresh\b/.test(raw);
  const keyword = refresh ? raw.replace(/^--refresh\b/, '').trim() : raw;

  let catalog;
  try {
    catalog = await deps.catalog.load(deps.runner, { cwd, signal: invocation?.signal, refresh });
  } catch (error) {
    return { kind: 'error', text: `カタログを取得できませんでした: ${String(error?.message ?? error)}` };
  }

  if (keyword.length > 0) {
    const tools = catalog.tools ?? [];
    // 名前か別名に完全一致するものがあれば、それを最優先で 1 件に絞る（/genspark-tools crawler など）
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
          `実行例: /genspark-run ${tool.name} {"<引数名>":"<値>"}\n` +
          `（モデルに実行させる場合は genspark_run ツールを使います）`,
      };
    }
  }
  return { kind: 'success', text: summarizeCatalog(catalog, { keyword, limit: 30 }) };
}

/** /genspark-models — 生成モデルの一覧（カタログの実 enum をそのまま読む）。 */
async function runModels(invocation, deps) {
  const cwd = commandCwd(invocation);
  const raw = String(invocation?.rawInput ?? '').trim();
  const kind = kindOfInput(raw);

  let catalog;
  try {
    catalog = await deps.catalog.load(deps.runner, { cwd, signal: invocation?.signal });
  } catch (error) {
    const message = String(error?.message ?? error);
    return { kind: 'error', text: `モデル一覧を取得できませんでした: ${message}` };
  }

  const entries = collectModels(catalog);
  if (entries.length === 0) {
    return { kind: 'error', text: 'カタログからモデル一覧を取得できませんでした（/genspark-tools image_generation で引数を確認できます）。' };
  }
  // 種類の指定が無ければ、残りは id の部分一致として扱う（例: /genspark-models kling）
  const filter = kind === undefined ? raw : undefined;
  return { kind: 'success', text: formatModelList(entries, { kind, filter }) };
}

/** /genspark-run — 任意ツールの実行（読み取り専用）。 */
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
        text: `引数の JSON を解釈できませんでした: ${error?.message ?? String(error)}\n${USAGE_RUN}`,
      };
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return { kind: 'error', text: `引数は JSON オブジェクトで指定してください。\n${USAGE_RUN}` };
    }
  }

  // カタログが取れるときだけ事前チェックする（取れないときは CLI の判断に任せる）
  try {
    const catalog = await deps.catalog.load(deps.runner, { cwd, signal: invocation?.signal });
    const tool = (catalog.tools ?? []).find(
      (entry) => entry.name === toolName || (entry.cli?.aliases ?? []).includes(toolName),
    );
    if (tool === undefined) {
      // CLI 内蔵コマンド（カタログに載らない）のうち読み取り専用のものだけ通す。
      // それ以外は誤字の可能性が高いので、実行せずに案内する（書き込み系の内蔵コマンドを避ける）。
      if (!CLI_BUILTIN_READONLY.has(toolName)) {
        return {
          kind: 'error',
          text:
            `Genspark に "${toolName}" というツールはありません。/genspark-tools <キーワード> で探してください。\n` +
            `（CLI 内蔵の読み取りコマンド ${[...CLI_BUILTIN_READONLY].join(' / ')} は実行できます）`,
        };
      }
    }
    if (tool.cli?.interactive_only) {
      return { kind: 'error', text: `"${tool.name}" は対話必須の操作のため、プラグインからは実行できません。` };
    }
    if (tool.cli?.requires_confirmation) {
      return {
        kind: 'error',
        text:
          `"${tool.name}" は確認が必要な操作です。コマンドには承認の仕組みが無いため実行しません。\n` +
          'モデルに依頼して genspark_run ツール（approve_write: true）から実行してください。',
      };
    }
  } catch {
    /* カタログ未取得は無視して実行する */
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
    return { kind: 'error', text: `実行に失敗しました: ${error?.message ?? String(error)}` };
  }
  return reportRun(toolName, result, null, cfg, deps.log);
}

/** 昇格ツール 1 つ分のコマンドハンドラを作る。 */
function makePromotedHandler(command, spec, deps) {
  return async (invocation) => {
    const cfg = deps.getConfig();
    const cwd = commandCwd(invocation);
    const input = String(invocation?.rawInput ?? '').trim();

    // 添付（画像・ファイル）は gsk が読めるローカルパスへ解決する。解決できなければ CLI は起動しない。
    let files;
    try {
      files = command.attachments === true ? await resolveAttachmentFiles(invocation, deps) : [];
    } catch (error) {
      return { kind: 'error', text: `${error?.message ?? error}` };
    }

    if (input.length === 0 && files.length === 0) {
      return { kind: 'error', text: `入力が必要です。使い方: /${command.name} ${command.hint}` };
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
    // 昇格ツールと同じく、動画などは設定値より長い下限を持つ
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
      return { kind: 'error', text: `実行に失敗しました: ${error?.message ?? String(error)}` };
    }
    return reportRun(gsk, result, built, cfg, deps.log);
  };
}

/**
 * コマンド結果をモデルへ引き継ぐための指示文。
 * 生の結果は画面のコマンド欄にも出ているので、同じ内容を繰り返させない。
 */
const FOLLOWUP_INSTRUCTION = [
  '生の出力は画面のコマンド欄にも表示されています。同じ内容を繰り返さず、日本語で要点と解釈を簡潔に伝えてください。',
  'URL や保存先のパスは必要な分だけ残してください。',
  'エラーの場合は原因と次の一手を短く説明してください。',
].join('\n');

/**
 * コマンド結果をエージェントの次のターンへ渡す（`agent.followup`）。
 *
 * ホストコマンドは仕様上モデルメッセージを作らない（結果テキストは UI がモデル履歴の外に描画する）。
 * そのため何もしないと「検索結果の山」がチャットに出るだけで、AI は内容を解釈できない。
 * `dsh-agent` の Agent は `followup`（next-turn のユーザーメッセージを積んでドライバを起こす）を持つので、
 * これで結果をモデルに読ませ、チャットで要点を答えさせられる。
 * `dsh-commands` も「コマンド実行者が明示的にエージェント作業を予約できる（トークン消費は通常の入力と同じ）」
 * と明記している＝仕様内の使い方。
 *
 * ホストが `followup` を持たない場合は何もしない（登録や実行を壊さない）。
 *
 * 重要: ハンドラの完了（ホストが記録する `command/done`）を引き継ぎ処理に待たせない。
 * 実機で「コマンドが完了せず、結果も AI の応答も出ない」状態を観測したため、
 * `followup` の実装が遅い・返らない・拒否される場合でもコマンド自体は必ず完結するよう、
 * 呼び出しを次のティックへ遅らせ、返り値の Promise は catch して握り潰す（await しない）。
 *
 * 送る message の `source` はセッション形式 V4 の検証を通る必要がある。
 * `{ kind: 'plugin', plugin: '…' }` は V3 の廃止済みラッパーで、
 * 「format v4 message requires a producer-owned source kind」で弾かれる（実機で発生）。
 * 正準は `{ kind: 'plugin:<プラグイン名>' }`。tests/preflight-message-source.mjs が実物の検証器で固定する。
 */
function scheduleFollowup(command, invocation, result, deps) {
  const cfg = deps.getConfig();
  if (cfg.commandFollowup === false) return;
  const agent = invocation?.agent;
  if (!agent || typeof agent.followup !== 'function') return;

  const input = String(invocation?.rawInput ?? '').trim();
  const text = typeof result?.text === 'string' ? result.text : '';
  const prompt = [
    `Genspark のコマンド実行結果です（/${command.name}${input.length > 0 ? ` ${input}` : ''}）。`,
    `状態: ${result?.kind === 'success' ? '成功' : 'エラー'}`,
    '',
    text,
    '',
    FOLLOWUP_INSTRUCTION,
  ].join('\n');

  const fail = (error) => {
    deps.log?.(`[genspark] コマンド結果の引き継ぎに失敗しました（/${command.name}）: ${error?.message ?? error}`);
  };

  const timer = setTimeout(() => {
    try {
      const returned = agent.followup({
        content: [{ type: 'text', text: prompt }],
        // セッション形式 V4 は `kind: 'plugin'`（V3 の廃止済みラッパー）を拒否する。
        // プラグインの正準 producer kind は `plugin:<プラグイン名>`
        // （dsh-session-format-v3-to-v4 の producerKind() が `plugin:${plugin}` を返す）。
        source: { kind: 'plugin:dsh-genspark' },
      });
      if (returned && typeof returned.then === 'function') returned.then(undefined, fail);
    } catch (error) {
      fail(error);
    }
  }, 0);
  // タイマーがプロセスの終了を引き止めないようにする
  timer?.unref?.();
}

/**
 * コマンド handler の完了を待つ既定の上限（ミリ秒）。
 *
 * ホストのコンポーザは `command/done` が届くまで送信トランザクション中（phase = submitting）で、
 * その間は入力欄が編集不可になり下書きも保持される
 * （dsh-client-ui-conversation/lib/client.js:17292 の `machineBusy` と `:17295` の `editable`。
 * 実測では画像生成のコマンドが 8 秒かかり、その間ずっと入力欄が凍結していた）。
 * 一定時間で handler を返してコマンドを完了させ、結果は `followup`（チャット）で届ける。
 * 設定 `commandInlineWaitMs` で変更でき、0 以下にすると従来どおり完了まで待つ。
 */
const INLINE_WAIT_DEFAULT_MS = 2500;

/** 早期リターンしたときにコマンド欄へ出す文言（結果はこのあとチャットに届く）。 */
const INLINE_WAIT_TEXT =
  'Genspark で実行中です。結果はこのあとチャットに届きます（待ち時間を短くするため、コマンド欄は先に完了します）。';

/** 不正な戻り値を日本語のエラー結果へ正規化する（例外は投げない）。 */
function normalizeOutcome(command, value, deps) {
  if (value !== null && typeof value === 'object' && (value.kind === 'success' || value.kind === 'error')) return value;
  deps.log?.(`[genspark] /${command.name} が不正な結果を返しました: ${JSON.stringify(value)?.slice(0, 200)}`);
  return { kind: 'error', text: `/${command.name} の結果を解釈できませんでした（プラグインの不具合の可能性があります）。` };
}

/** 例外を日本語のエラー結果へ正規化する（例外は投げない）。 */
function outcomeFromError(command, error, deps) {
  const detail = error?.stack ?? error?.message ?? String(error);
  deps.log?.(`[genspark] /${command.name} の実行中に例外が発生しました: ${detail}`);
  return {
    kind: 'error',
    text: [
      `/${command.name} の実行中に予期しないエラーが発生しました: ${error?.message ?? String(error)}`,
      command.gsk === undefined
        ? 'もう一度試すか、/genspark で接続状態を確認してください（詳細は DSH のログ）。'
        : `引数の形は /genspark-tools ${command.gsk} で確認できます（詳細は DSH のログ）。`,
    ].join('\n'),
  };
}

/**
 * 早期リターンまでの待ち時間を解決する。0 は「早期リターンしない（従来どおり完了まで待つ）」。
 *
 * 結果を届ける手段（`agent.followup` と commandFollowup）が無い場合は早期リターンしない。
 * 待たずに返すと結果がどこにも出ずに消えてしまうため。
 */
function inlineWaitMs(invocation, deps) {
  if (typeof invocation?.agent?.followup !== 'function') return 0;
  let cfg = {};
  try {
    cfg = deps.getConfig?.() ?? {};
  } catch {
    cfg = {};
  }
  if (cfg?.commandFollowup === false) return 0;
  const raw = cfg?.commandInlineWaitMs;
  if (raw === undefined || raw === null || raw === '') return INLINE_WAIT_DEFAULT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value)) return INLINE_WAIT_DEFAULT_MS;
  return value > 0 ? value : 0;
}

/**
 * コマンドの handler を包み、(1) 例外を日本語のエラー結果へ変換し、(2) 結果をモデルへ引き継ぎ、
 * (3) 長時間かかる実行では先にコマンドを完了させて入力欄の凍結を短くする。
 *
 * 例外を投げるとホストは生のエラーメッセージをそのまま画面に出すため、
 * どのコマンドでも日本語のエラー結果として返し、原因はログに残す
 * （ホスト側も settleThrown で `command/done` を記録するが、利用者に見せる文言はこちらで揃える）。
 * 引き継ぎの完了は待たない（`scheduleFollowup` は同期）。
 *
 * 早期リターンした場合、handler は動いたままなので、結果が確定した時点で `followup` が届く
 * （呼び出し元へ返すのは「実行中です」の 1 行）。このとき **RPC のキャンセル信号は転送を止める**:
 * `dsh-commands` の signal は「UI リクエストが所有する」もので、handler が返ったあとの abort が
 * 背景の CLI 実行を巻き込まないようにするため（CLI 側のタイムアウトで保護する）。
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

    const waitMs = inlineWaitMs(invocation, deps);
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
        resolve(finished ? finalResult : { kind: 'success', text: INLINE_WAIT_TEXT });
      }, waitMs);
      // タイマーがプロセスの終了を引き止めないようにする
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
 * 登録するコマンド定義を組み立てる。
 *
 * `@deepseek-ai/dsh-commands` の契約:
 *   - name は /^[a-z][a-z0-9_-]*$/、description は非空文字列、handler は関数。
 *   - `input: { hint }` を付けるとメニューから選んだとき即実行せず、入力を促す（hint は必須・非空）。
 *   - handler は { kind: 'success' | 'error', text } を返す。
 *
 * @returns {Array<{name: string, description: string, input?: {hint: string}, handler: Function}>}
 */
export function buildGensparkCommands({ getConfig, runner, catalog, log, ctx } = {}) {
  // 設定の読み込みが失敗しても登録・実行を止めない（既定値で動かし、原因はログに残す）
  const config = () => {
    try {
      return (typeof getConfig === 'function' ? getConfig() : getConfig) ?? {};
    } catch (error) {
      log?.(`[genspark] 設定の読み込みに失敗しました: ${error?.message ?? error}`);
      return {};
    }
  };
  const deps = { getConfig: config, runner, catalog, log, ctx };

  // どのコマンドを出すかは昇格ツールと同じカテゴリ設定に従う
  const wanted = resolvePromotedCategories(config().promotedCategories, log);
  const promoted = [];
  for (const command of PROMOTED_COMMANDS) {
    const spec = SPEC_BY_GSK.get(command.gsk);
    if (spec === undefined) continue;
    if (!wanted.has(spec.category)) continue;
    promoted.push({
      name: command.name,
      description: command.description,
      // 添付を受け取るコマンドはホストへ明示する（未宣言だと実行前に attachmentsUnsupported で拒否される）
      input: command.attachments === true ? { hint: command.hint, attachments: true } : { hint: command.hint },
      gsk: command.gsk,
      handler: makePromotedHandler(command, spec, deps),
    });
  }

  let commands = [];
  const core = [
    {
      name: 'genspark',
      description: '接続状態・アカウント・残クレジット・コマンド一覧を表示します',
      handler: (invocation) => runStatus(invocation, deps, () => commands),
    },
    {
      name: 'genspark-tools',
      description: '全ツールを検索して引数の形を表示します（--refresh でキャッシュ更新）',
      input: { hint: USAGE_TOOLS },
      handler: (invocation) => runTools(invocation, deps),
    },
    {
      name: 'genspark-models',
      description: '画像・動画・音声・文字起こしで選べるモデルの一覧を表示します',
      input: { hint: '画像 / 動画 / 音声 / 文字起こし（省略で全部、id の一部でも絞れます）' },
      handler: (invocation) => runModels(invocation, deps),
    },
    {
      name: 'genspark-run',
      description: '任意のツールを読み取り専用で実行します（書き込みは genspark_run ツールから）',
      input: { hint: 'ツール名 [JSON引数]（例: me / web_search {"q":"…"}）' },
      handler: (invocation) => runGeneric(invocation, deps),
    },
  ];
  commands = [...core, ...promoted];
  // コマンド結果をモデルにも渡し、AI がチャットで解釈を返せるようにする（設定 commandFollowup で無効化）。
  return commands.map((command) => ({ ...command, handler: withFollowup(command, deps) }));
}
