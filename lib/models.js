/**
 * 生成モデル一覧（画像・動画・音声・文字起こし）。
 *
 * `gsk ls` のカタログは、生成系ツールの `model` 引数に**サーバー側の実 enum**を載せている
 * （実測: image_generation 15 / video_generation 21 / audio_generation 25 / audio_transcribe 3）。
 * つまりモデルの追加・廃止はカタログの更新だけで追随でき、プラグイン側に静的な一覧を持つ必要がない。
 * ここではその enum を読み出して、人間にも AI にも読みやすい形に整形する。
 */

/** モデルを選べるツールと、それを包むコマンドの対応。 */
export const MODEL_KINDS = [
  { kind: 'image', label: '画像生成', tool: 'image_generation', command: '/genspark-image', toolName: 'genspark_generate_image' },
  { kind: 'video', label: '動画生成', tool: 'video_generation', command: '/genspark-video', toolName: 'genspark_generate_video' },
  { kind: 'audio', label: '音声・音楽生成', tool: 'audio_generation', command: '/genspark-audio', toolName: 'genspark_generate_audio' },
  { kind: 'transcribe', label: '文字起こし', tool: 'audio_transcribe', command: '/genspark-analyze-media', toolName: 'genspark_analyze_media' },
];

/** 入力ゆれ（日本語・別名）を kind へ寄せる。 */
const KIND_ALIASES = {
  image: ['image', 'img', '画像', '画像生成'],
  video: ['video', '動画', '動画生成'],
  audio: ['audio', '音声', '音楽', '音声生成'],
  transcribe: ['transcribe', 'transcription', '文字起こし', '書き起こし', '音声認識'],
};

/** 入力文字列から kind を推定する（該当なしは undefined）。 */
export function kindOfInput(input) {
  const text = String(input ?? '').trim().toLowerCase();
  if (text.length === 0) return undefined;
  for (const [kind, aliases] of Object.entries(KIND_ALIASES)) {
    if (aliases.includes(text)) return kind;
  }
  return undefined;
}

/**
 * カタログからモデル一覧を集める。
 * @returns {Array<{kind: string, label: string, tool: string, command: string, toolName: string, ids: string[]}>}
 */
export function collectModels(catalog) {
  const tools = catalog?.tools ?? [];
  const entries = [];
  for (const meta of MODEL_KINDS) {
    const tool = tools.find((item) => item?.name === meta.tool);
    const spec = tool?.parameters?.properties?.model;
    const ids = Array.isArray(spec?.enum) ? spec.enum.filter((id) => typeof id === 'string' && id.length > 0) : [];
    if (ids.length === 0) continue;
    entries.push({ ...meta, ids });
  }
  return entries;
}

/**
 * 一覧をテキストへ整形する。
 * @param entries collectModels の結果
 * @param options.kind 絞り込む kind（省略で全部）
 * @param options.filter モデル id の部分一致（省略で絞らない）
 */
export function formatModelList(entries, { kind, filter } = {}) {
  let picked = entries;
  if (kind !== undefined) picked = picked.filter((entry) => entry.kind === kind);
  if (filter !== undefined && String(filter).trim().length > 0) {
    const needle = String(filter).trim().toLowerCase();
    picked = picked
      .map((entry) => ({ ...entry, ids: entry.ids.filter((id) => id.toLowerCase().includes(needle)) }))
      .filter((entry) => entry.ids.length > 0);
  }
  if (picked.length === 0) {
    return '該当するモデルが見つかりませんでした（`/genspark-tools image_generation` で引数の形を確認できます）。';
  }

  const lines = [];
  for (const entry of picked) {
    lines.push(`### ${entry.label} — ${entry.ids.length} モデル（${entry.command} / ${entry.toolName}）`);
    lines.push(entry.ids.join(' / '));
    lines.push('');
  }
  lines.push(
    'モデルを変えるときは、生成コマンドの `model` 引数に id を渡します。コマンドからは AI に' +
      '「gemini/veo3.1 で動画を作って」のように頼む形でも指定できます。' +
      '各モデルの対応比率・尺・音声の有無は AI に「kling/v3 の仕様を教えて」と聞くか、' +
      '`get_model_info` を実行すると分かります。',
  );
  return lines.join('\n');
}
