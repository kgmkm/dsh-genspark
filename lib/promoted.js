/**
 * カテゴリ厳選の「型付きツール」（昇格ツール）。
 *
 * genspark_run でも全 302 ツールに到達できるが、ツール名と引数名を毎回調べる必要がある。
 * 利用頻度が高く引数が安定しているものだけを DSH のツールとして昇格させ、
 * 引数の探索を省略できるようにする（＝ここの存在意義）。
 *
 * 昇格ツールは genspark_run と同じ経路（runner.runTool → gsk <tool> --args-file …）を使う。
 * 追加の CLI オプション（生成メディアの `-o/--output-file`）は toolArgs として後置する。
 *
 * 設計上の約束:
 *   - 具体的な引数名が変わっても壊れないよう、全ツールに `extra`（任意 JSON）の逃げ道を用意する。
 *     `extra` は型付き引数で指定されなかったキーだけを補う（型付き引数が優先）。
 *     ただし CLI はスキーマに無い引数名をサーバー呼び出しの前に拒否する（実測）。
 *     extra で渡せるのは「そのツールのスキーマに存在するが型付きにしていない」パラメータだけ。
 *   - 引数の組み合わせ不正は build() が日本語メッセージで throw し、そのままモデルへ返す。
 *   - 昇格ツールはいずれも確認不要（requires_confirmation=false / interactive_only=false）なので
 *     常に `--no-input` を渡す。書き込み承認の対象にはならない。
 */
import { closeSync, existsSync, openSync, readSync, renameSync, statSync } from 'node:fs';
import { extname, resolve as resolvePath } from 'node:path';
import { describeRun, CRAWLER_HINT } from './result.js';

/** テキスト出力（既存ツールと同じ形）。 */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
};

/** 型付き引数で表現しない残りの引数を渡すための逃げ道。 */
const EXTRA_PARAM = {
  type: 'json',
  description:
    'このツールのスキーマには存在するが、上の型付き引数として用意していないパラメータを渡すための任意 JSON オブジェクト。' +
    '例: 動画生成の tier / first_frame_url / video_urls / input_mode、画像生成の repo_id / query_file。' +
    '型付き引数で指定したキーが優先される。' +
    'スキーマに無いキーを渡すと CLI がサーバー呼び出し前に拒否する（クレジットは消費しない）ので、' +
    'genspark_tools を full=true で呼んで正確な引数名を確認すること。',
};

/** 生成メディアの保存先（CLI の -o/--output-file に渡す）。 */
const SAVE_TO_PARAM = {
  type: 'string',
  description:
    '生成物を保存するローカルファイルのパス（例: ./out/image.png）。' +
    '省略すると URL だけが返る。相対パスはセッションの作業ディレクトリ基準。',
};

const MODEL_PARAM_IMAGE = {
  type: 'string',
  enum: [
    'gpt-image-2',
    'fal-ai/bytedance/seedream/v5/lite',
    'fal-ai/bytedance/seedream/v5/pro',
    'xai/grok-imagine-image',
    'qwen-image-3',
  ],
  description:
    '使用モデル。省略時は nano-banana-2-flash-lite。一覧は genspark_model_info で確認できる（enum は代表例）。',
};

const MODEL_PARAM_VIDEO = {
  type: 'string',
  enum: ['kling/v3', 'kling/o3', 'gemini/veo3.1', 'minimax/h3', 'minimax/h3-max', 'wan/v2.7', 'vidu/q4', 'runway/gen4_turbo'],
  description: '使用モデル（必須）。enum は代表例。無音で良い場合を除き audio_enable の扱いに注意（genspark_model_info 参照）。',
};

const MODEL_PARAM_AUDIO = {
  type: 'string',
  enum: ['CassetteAI/music-generator', 'alibaba/qwen-audio-3-tts', 'bytedance/seed-audio-1.0', 'elevenlabs/music'],
  description: '使用モデル（enum は代表例）。params の形はモデルごとに異なるため、先に genspark_model_info で確認する。',
};

/** 業務上よく使うカテゴリの表示名。'social' は枠だけ用意（ツールは後日）。 */
export const PROMOTED_CATEGORIES = {
  search: '検索・調査',
  media: '生成メディア',
  social: 'ソーシャルメディア',
};

/** extra を型付き引数の後ろに重ねる（型付きが優先）。 */
function withExtra(typed, extra) {
  const result = { ...(typed ?? {}) };
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra)) {
      if (result[key] === undefined && value !== undefined) result[key] = value;
    }
  }
  return result;
}

/** save_to を CLI の `-o` オプションへ解決する。 */
function resolveSaveTo(saveTo, cwd) {
  const value = typeof saveTo === 'string' ? saveTo.trim() : '';
  if (value.length === 0) return null;
  return resolvePath(cwd, value);
}

/** 先頭バイトから実際のファイル形式を推定する（CLI は `-o` の名前をそのまま使うため実体と食い違うことがある）。 */
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
        /* 閉じられない場合は無視する */
      }
    }
  }
}

/**
 * 保存ファイルの拡張子を実体に合わせる。
 *
 * 実測: `/genspark-image` は `genspark-out/<日時>-image-….png` に保存するが、nano-banana が返すのは
 * JPEG（先頭 `FF D8 FF E0 … JFIF`）だった。拡張子が嘘だと閲覧ソフトや画像ツールが開けないため、
 * 先頭バイトで判定して食い違っていれば改名する（改名したことは報告文に出す）。
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

/** 保存されたファイルの実在・形式・サイズを 1 行で報告する（コマンド側からも使う）。 */
export function describeSavedFile(path) {
  try {
    if (existsSync(path)) {
      const normalized = normalizeSavedFile(path);
      const stats = statSync(normalized.path);
      const kind = normalized.format ? `${normalized.format} / ` : '';
      const moved = normalized.renamed ? `（実体が ${normalized.format} のため拡張子を修正）` : '';
      return `保存ファイル: ${normalized.path}（${kind}${stats.size} バイト）${moved}`;
    }
  } catch {
    /* 判定できない場合は下の案内にフォールバックする */
  }
  return `保存ファイル: ${path}（存在を確認できませんでした。JSON の file 情報と stderr を確認してください）`;
}

function requireString(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) throw new Error(`${label} は必須です。`);
  return text;
}

/**
 * URL 前提の引数を検証する（crawler / summarize_large_document 用）。
 *
 * 実測: `/genspark-crawl これはテストです。昨日…` のように日本語の質問を渡すと、
 * CLI はそれを URL として取得しようとして
 * `Genspark API エラー: No content found or crawler failed for …` を返す。
 * ここで弾いて、日本語の誘導文をモデルとユーザーに返す。
 * ローカルファイルは CLI が自動アップロードするため通す。
 */
function requireUrlOrFile(value, label, hint) {
  const text = requireString(value, label);
  if (/^https?:\/\//i.test(text)) return text;
  if (existsSync(text)) return text;
  const shown = text.length > 120 ? `${text.slice(0, 120)}…` : text;
  throw new Error(
    `${label} には http(s) で始まる URL か、存在するローカルファイルのパスを指定してください` +
      `（受け取った値: "${shown}"）。${hint}` +
      'CLI にそのまま渡したい場合は genspark_run（コマンドなら /genspark-run）を使ってください。',
  );
}

function cleanObject(value) {
  const result = {};
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (entry !== undefined && entry !== null && !(typeof entry === 'string' && entry.length === 0)) result[key] = entry;
  }
  return result;
}

/**
 * 昇格ツールの定義表。
 *
 * - name     … DSH のツール名（genspark_ 接頭辞で既存ツールとの衝突を避ける）
 * - category … PROMOTED_CATEGORIES のキー
 * - gsk      … Genspark CLI 側のツール名
 * - build(args, cwd) … { args: Genspark 引数, options: 追加 CLI オプション, saveTo?: 絶対パス }
 */
export const PROMOTED_TOOLS = [
  {
    name: 'genspark_web_search',
    category: 'search',
    gsk: 'web_search',
    timeoutMs: 300000,
    description:
      'Genspark の Web 検索を実行する（従来の検索エンジン相当。結果は title/snippet/URL の JSON）。' +
      '最新情報・ニュース・一般知識の調査に使う。DSH 内蔵の web_search と同等の用途だが、Genspark 側の検索基盤を使う。' +
      '結果が多すぎる場合は maxChars を超えた分が省略されるので、q を具体的にする。',
    parameters: {
      q: { type: 'string', required: true, description: '検索クエリ（例: "latest AI news"）。自然文でもキーワードでも良い。' },
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
      'Genspark で画像を検索する。画像 URL・タイトル・出典を JSON で返す。' +
      '「〜の写真を探して」という依頼や、生成メディアの参照画像（image_urls）を探す用途に使う。',
    parameters: {
      query: { type: 'string', required: true, description: '画像検索語（例: "Eiffel Tower at sunset"）。英語が安定する。' },
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
      '指定 URL のページ本文を取得して Markdown で返す（HTML・PDF・Office 文書に対応）。' +
      'DSH 内蔵の web_fetch で本文が取れない場合や、PDF を読みたい場合の選択肢。' +
      'Cloudflare 等でブロックされるサイトは render_js=true、生の HTML/JSON が必要な場合は raw=true（offset で分割取得）。',
    parameters: {
      url: { type: 'string', required: true, description: 'http/https の URL。' },
      render_js: {
        type: 'boolean',
        description: 'JS レンダリングを有効化する（403 / Cloudflare / 動的コンテンツ用）。既定 false。',
      },
      raw: { type: 'boolean', description: 'Markdown 変換せず生のレスポンス本文を返す。既定 false。' },
      offset: { type: 'integer', description: 'raw=true のとき読み出し開始バイト位置（最大 1048576）。続きを取るのに使う。' },
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
      '学術論文を検索する（タイトル・著者・掲載誌・被引用数を返す）。' +
      '論文の調査や参考文献探しに使う。プロジェクト未指定でも動作する（サーバー側で自動割当）。',
    parameters: {
      query: { type: 'string', required: true, description: '論文検索クエリ（例: "diffusion model for speech synthesis"）。' },
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
      '地図・場所・経路を調べる（地理に関する問い専用。一般知識や天気には使わない）。\n' +
      '使い分け: engine="maps" で場所検索（query 必須）、engine="maps_directions" で距離・経路（start_addr と end_addr 必須）。\n' +
      'query_type は search / place / distances / directions のいずれか。',
    parameters: {
      query_type: {
        type: 'string',
        required: true,
        enum: ['search', 'place', 'distances', 'directions'],
        description: '問いの種類。',
      },
      engine: { type: 'string', required: true, enum: ['maps', 'maps_directions'], description: '使用エンジン。' },
      query: { type: 'string', description: 'engine="maps" のときの検索語（例: "東京駅周辺のカフェ"）。' },
      start_addr: { type: 'string', description: 'engine="maps_directions" のときの起点住所。' },
      end_addr: { type: 'string', description: 'engine="maps_directions" のときの終点住所。' },
      travel_mode: {
        type: 'string',
        enum: ['0', '1', '2', '3', '4', '6', '9'],
        description: '移動手段（Google Maps の travel mode 値。0=車, 1=自転車, 2=徒歩, 3=公共交通など）。',
      },
      avoid: { type: 'string', enum: ['highways', 'tolls', 'ferries'], description: '回避条件。' },
      prefer: { type: 'string', enum: ['bus', 'subway', 'train', 'tram_light_rail'], description: '優先する交通手段。' },
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
        requireString(args.start_addr, 'start_addr（engine=maps_directions のとき）');
        requireString(args.end_addr, 'end_addr（engine=maps_directions のとき）');
      } else {
        requireString(args.query, 'query（engine=maps のとき）');
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
      '大きな文書（PDF・Web ページ・Word など）を読み込んで、指定した質問に答える。' +
      '長い資料の要約や、特定箇所の質問に使う。URL はローカルファイルのパスでもよい（CLI が自動アップロードする）。' +
      '処理に時間がかかることがある。',
    parameters: {
      url: { type: 'string', required: true, description: '文書の URL、またはローカルファイルのパス。' },
      question: { type: 'string', required: true, description: '文書に対する具体的な質問（例: "要点を 5 つ挙げて"）。' },
      extra: EXTRA_PARAM,
    },
    build: (args) => ({
      args: withExtra(
        {
          url: requireUrlOrFile(
            args.url,
            'url',
            '要約したい文書の URL かローカルファイルのパスを指定してください（crawler と同じく URL 前提のツールです）。',
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
      '画像を生成する（テキストから生成、または image_urls を参照した編集・リスタイル）。' +
      'プロンプトは英語が安定する。生成された画像の URL を返す。' +
      'save_to を指定すると CLI がローカルへダウンロードする。' +
      '用途の判定に迷ったら query にやりたいことを書き、参照画像がある場合は image_urls に画像 URL（またはローカルパス）を入れる。',
    parameters: {
      query: {
        type: 'string',
        description: '生成したい画像の詳細な説明（英語推奨）。画像内に入れたい文字はそのままでよい。image_urls で参照画像を渡す場合も、何をするかを書く。',
      },
      image_urls: {
        type: 'array',
        items: { type: 'string' },
        description: '参照画像の URL またはローカルパス（編集・リスタイル・同一人物/同一商品の維持には必須）。',
      },
      model: MODEL_PARAM_IMAGE,
      thinking_level: { type: 'string', enum: ['minimal', 'medium', 'high'], description: 'nano-banana-2.1 専用の思考量（他モデルでは無視）。' },
      aspect_ratio: {
        type: 'string',
        enum: ['1:1', '4:3', '16:9', '9:16', '3:4', '2:3', '3:2', 'auto'],
        description: 'アスペクト比。画像編集（image_urls あり）では auto が無難。',
      },
      image_size: { type: 'string', enum: ['auto', '0.5k', '1k', '2k', '3k', '4k'], description: '解像度。既定 auto。' },
      bbox: { type: 'array', items: { type: 'number' }, description: 'bbox セグメンテーションモデル用の [x1, y1, x2, y2]。通常は不要。' },
      save_to: SAVE_TO_PARAM,
      extra: EXTRA_PARAM,
    },
    build: (args, cwd) => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      const urls = Array.isArray(args.image_urls) ? args.image_urls : undefined;
      if (query.length === 0 && (!urls || urls.length === 0)) {
        throw new Error('query（生成内容の説明）か image_urls（参照画像）の少なくとも一方を指定してください。');
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
      '動画を生成する（テキストから、または image_urls を先頭フレーム/参照にした生成）。' +
      'query（英語のプロンプト）と model が必須。生成には数分かかることがあり、完了まで待って結果の URL を返す。' +
      '音声が必要な場合は audio_enable=true（音声対応モデルのみ。コスト増）。' +
      'save_to を指定すると CLI がローカルへダウンロードする。' +
      'first_frame_url / video_urls / tier など上級パラメータは extra で渡す（genspark_tools の full=true で確認）。',
    parameters: {
      query: { type: 'string', required: true, description: '生成したい動画の詳細な説明（英語）。モデルへそのまま渡る。' },
      model: MODEL_PARAM_VIDEO,
      image_urls: {
        type: 'array',
        items: { type: 'string' },
        description: '参照キーフレーム画像の URL またはローカルパス（image-to-video。1 枚モデルなら 1 枚）。',
      },
      aspect_ratio: {
        type: 'string',
        enum: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '2:1', '3:2', '2:3', '21:9', '9:21', '5:4', '4:5'],
        description: 'アスペクト比。image-to-video では入力画像に合わせる。',
      },
      duration: { type: 'number', description: '長さ（秒）。既定 5。0 = 自動（一部モデルのみ）。' },
      video_size: {
        type: 'string',
        enum: ['auto', '480p', '720p', '768p', '1080p', '2K', '4k'],
        description: '解像度。既定 auto（多くのモデルは 720p）。',
      },
      audio_enable: { type: 'boolean', description: '音声・ナレーションが必要なとき true（kling/v3 は true にしないと無音）。' },
      reference_mode: {
        type: 'boolean',
        description: '参照モード（画像を先頭フレームではなくキャラクター/スタイルの参照として使う）。image_urls 必須。',
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
      '音声を生成する（読み上げ・効果音・音楽）。prompt に読み上げ原稿または生成内容の説明を書く。' +
      'モデルごとに params の形が違うため、既定値でうまくいかない場合は先に genspark_model_info で params_schema を確認する。' +
      'save_to を指定すると CLI がローカルへダウンロードする。',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'TTS なら読み上げ原稿、音楽・効果音なら生成内容の説明。',
      },
      model: MODEL_PARAM_AUDIO,
      audio_type: { type: 'string', enum: ['speech', 'music', 'sound_effect'], description: '生成種別。既定 speech。' },
      params: {
        type: 'json',
        description:
          'モデル固有パラメータの JSON（speakers, speed, duration, lyrics, output_format など）。' +
          'genspark_model_info の params_schema に従うこと。',
      },
      speaker: { type: 'string', description: 'プリセット音声（可能なら params 側で指定する）。' },
      duration: { type: 'integer', description: '効果音・音楽の長さ（秒。可能なら params 側で指定する）。' },
      lyrics: { type: 'string', description: '歌曲モデル用の歌詞（可能なら params 側で指定する）。' },
      file_name: { type: 'string', description: '生成物の名前（既定 "audio"）。' },
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
    name: 'genspark_model_info',
    category: 'media',
    gsk: 'get_model_info',
    timeoutMs: 300000,
    description:
      '生成モデルの詳細（対応機能・params_schema・利用可能な話者・プロンプト指針）を調べる。' +
      '画像・動画・音声を生成する前に、モデル名の確認や params の形の確認に使う。',
    parameters: {
      model_names: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '調べるモデル名/ID の配列（例: ["kling/v3", "alibaba/qwen-audio-3-tts"]）。',
      },
      extra: EXTRA_PARAM,
    },
    build: (args) => {
      const names = Array.isArray(args.model_names) ? args.model_names.filter((entry) => typeof entry === 'string' && entry.trim().length > 0) : [];
      if (names.length === 0) throw new Error('model_names（モデル名の配列）は必須です。');
      return { args: withExtra({ model_names: names }, args.extra) };
    },
  },
];

/** 有効化されたカテゴリ名の集合を解決する（未指定は検索・調査 + 生成メディア）。 */
export function resolvePromotedCategories(categories, log) {
  const list = Array.isArray(categories) ? categories : ['search', 'media'];
  const wanted = new Set();
  for (const entry of list) {
    const key = String(entry ?? '').trim();
    if (key.length === 0) continue;
    if (!Object.hasOwn(PROMOTED_CATEGORIES, key)) {
      log?.(`[genspark] 未知のカテゴリ "${key}" は無視します（search / media / social）`);
      continue;
    }
    wanted.add(key);
  }
  return wanted;
}

/** genspark_status 用の 1 行要約。 */
export function promotedSummary(categories) {
  const wanted = resolvePromotedCategories(categories);
  const parts = [];
  for (const [key, label] of Object.entries(PROMOTED_CATEGORIES)) {
    const count = PROMOTED_TOOLS.filter((spec) => spec.category === key).length;
    if (count === 0) continue;
    parts.push(`${key}=${label} ${count} ツール${wanted.has(key) ? '' : '（無効）'}`);
  }
  return parts.join(' / ');
}

/** 指定カテゴリの昇格ツールを DSH ツールとして組み立てる。 */
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

        // 生成メディア（動画など）は設定値より長い下限を持つ
        const timeoutMs = Math.max(Number(cfg.timeoutMs ?? 600000), Number(spec.timeoutMs ?? 0));
        let result;
        try {
          result = await runner.runTool(spec.gsk, built.args, {
            cwd,
            signal: exec?.signal,
            timeoutMs,
            globalArgs: ['--output', 'json', '--timeout', String(timeoutMs), '--no-input'],
            toolArgs: built.options ?? [],
          });
        } catch (error) {
          if (error?.code === 'GSK_ENTRY_NOT_FOUND') return error.message;
          return `実行に失敗しました: ${error?.message ?? String(error)}`;
        }

        const described = describeRun(result, { tool: spec.gsk, maxChars: Number(cfg.maxOutputChars ?? 100000) });
        if (cfg.debug && result.stderr?.trim()) {
          log?.(`[genspark] ${spec.gsk} stderr: ${result.stderr.trim().slice(0, 500)}`);
        }
        let text = described.text;
        if (built.saveTo && described.ok) text += `\n${describeSavedFile(built.saveTo)}`;
        return text;
      },
    }),
  );
}
