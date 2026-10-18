/**
 * 生成コマンドの誤爆ガード。
 *
 * 背景（実測）:
 *   生成コマンドは入力文字列を**そのまま生成プロンプト**として CLI へ渡す。
 *   そのため `/genspark-video 動画モデルのリストください` と書くと、
 *   「モデルの一覧が欲しい」という意図が動画生成として実行され、1 本あたり数百クレジットを消費する
 *   （2026-10-18 実測: 2 回で約 924 クレジット）。
 *
 * 方針:
 *   - 生成系（image_generation / video_generation / audio_generation）のコマンドだけで判定する。
 *   - 「モデルの一覧」「使い方」など**メタな依頼**だけを対象にし、通常の生成プロンプトは素通しする
 *     （例: 「モデルのような女性が歩く動画」は生成する）。
 *   - 添付ファイルがある場合は、生成対象が明確なので判定しない。
 *   - 誤検出より「一覧を返す」方が安全（クレジットを消費しない）ため、判定は狭く・確実に取る。
 */

/** クレジットを消費する生成ツール。 */
const GENERATION_TOOLS = new Set(['image_generation', 'video_generation', 'audio_generation']);

/** 生成ツール → モデル一覧の kind（lib/models.js の MODEL_KINDS と対応）。 */
const KIND_BY_TOOL = {
  image_generation: 'image',
  video_generation: 'video',
  audio_generation: 'audio',
};

/** 使い方だけを聞いている入力（前後に説明が無いもの）。 */
const USAGE_RE = /^(使い方|つかいかた|ヘルプ|help|usage|何ができる|なにができる)(の)?[\s?？!！。]*$/i;

/** モデルという語。 */
const MODEL_RE = /(モデル|model)/i;

/** 一覧を求めている語。 */
const LIST_RE = /(一覧|リスト|ラインナップ|種類|候補|list|which|what)/i;

/** 「教えて」系の依頼語（「〜してください」は含めない。生成依頼と衝突するため）。 */
const ASK_RE = /(教えて|見せて|見たい|知りたい|出して|show|tell)/i;

/** 「使える / 選べる」系。 */
const AVAILABLE_RE = /(使える|使いたい|選べる|利用できる|利用可能|対応している|available)/i;

/** 種類だけで「モデル」と書かれた入力（例: 動画モデル / モデル）。 */
const BARE_RE = /^(画像|動画|音声|音楽)?\s*(生成)?\s*(モデル|models?)$/i;

/**
 * 生成ツールかどうか。
 * @param {string} tool gsk ツール名（例: video_generation）
 */
export function isGenerationTool(tool) {
  return GENERATION_TOOLS.has(String(tool ?? ''));
}

/**
 * 生成ツールに対応するモデル一覧の kind（該当なしは undefined）。
 * @param {string} tool gsk ツール名
 */
export function modelKindOfTool(tool) {
  return KIND_BY_TOOL[String(tool ?? '')];
}

/**
 * 入力が「生成」ではなく「メタな依頼」かどうかを判定する。
 *
 * @param {string} input コマンドの生入力
 * @returns {{ kind: 'models' } | { kind: 'usage' } | undefined}
 *   models … モデル一覧が欲しい / usage … 使い方が知りたい
 */
export function detectMetaIntent(input) {
  const text = String(input ?? '').trim();
  if (text.length === 0) return undefined;

  if (USAGE_RE.test(text)) return { kind: 'usage' };

  // モデルの話をしていない入力は、通常の生成プロンプトとして扱う
  if (!MODEL_RE.test(text)) return undefined;

  if (BARE_RE.test(text)) return { kind: 'models' };
  if (LIST_RE.test(text)) return { kind: 'models' };
  if (ASK_RE.test(text)) return { kind: 'models' };
  if (AVAILABLE_RE.test(text)) return { kind: 'models' };
  return undefined;
}
