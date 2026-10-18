/**
 * Generation model list (image / video / audio / transcription).
 *
 * The `gsk ls` catalog puts the **server-side actual enum** in the `model` argument of generation tools
 * (measured: image_generation 15 / video_generation 21 / audio_generation 25 / audio_transcribe 3).
 * That means model additions and removals can be followed by updating the catalog alone, and the plugin
 * does not need to keep a static list. This module reads that enum and formats it so that both humans
 * and AI can read it easily.
 */

/** Mapping between tools with selectable models and their wrapping commands. */
export const MODEL_KINDS = [
  { kind: 'image', label: 'Image generation', tool: 'image_generation', command: '/genspark-image', toolName: 'genspark_generate_image' },
  { kind: 'video', label: 'Video generation', tool: 'video_generation', command: '/genspark-video', toolName: 'genspark_generate_video' },
  { kind: 'audio', label: 'Audio / music generation', tool: 'audio_generation', command: '/genspark-audio', toolName: 'genspark_generate_audio' },
  { kind: 'transcribe', label: 'Transcription', tool: 'audio_transcribe', command: '/genspark-analyze-media', toolName: 'genspark_analyze_media' },
];

/**
 * Map input variants (aliases) to a kind.
 *
 * The Japanese aliases are written as \uXXXX escapes so this file stays ASCII-only, but they are
 * **functional**: users pass the Japanese words for video / image / music to these commands in practice.
 */
const KIND_ALIASES = {
  image: ['image', 'img', 'image generation', '\u753b\u50cf', '\u753b\u50cf\u751f\u6210'],
  video: ['video', 'video generation', '\u52d5\u753b', '\u52d5\u753b\u751f\u6210'],
  audio: ['audio', 'music', 'sound', 'audio generation', 'music generation', '\u97f3\u58f0', '\u97f3\u697d', '\u97f3\u58f0\u751f\u6210'],
  transcribe: [
    'transcribe',
    'transcription',
    'speech recognition',
    'speech-to-text',
    '\u6587\u5b57\u8d77\u3053\u3057',
    '\u66f8\u304d\u8d77\u3053\u3057',
    '\u97f3\u58f0\u8a8d\u8b58',
  ],
};

/** Infer the kind from the input string (undefined when no match). */
export function kindOfInput(input) {
  const text = String(input ?? '').trim().toLowerCase();
  if (text.length === 0) return undefined;
  for (const [kind, aliases] of Object.entries(KIND_ALIASES)) {
    if (aliases.includes(text)) return kind;
  }
  return undefined;
}

/**
 * Collect the model list from the catalog.
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
 * Format the list as text.
 * @param entries Result of collectModels
 * @param options.kind Kind to narrow to (all when omitted)
 * @param options.filter Substring match on the model id (no filtering when omitted)
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
    return 'No matching models were found (use `/genspark-tools image_generation` to check the argument shape).';
  }

  const lines = [];
  for (const entry of picked) {
    const count = entry.ids.length;
    lines.push(`### ${entry.label} — ${count} ${count === 1 ? 'model' : 'models'} (${entry.command} / ${entry.toolName})`);
    lines.push(entry.ids.join(' / '));
    lines.push('');
  }
  lines.push(
    'To change the model, pass its id to the `model` argument of a generation command. From a command, you can also ' +
      'ask the AI, e.g. "create a video with gemini/veo3.1". ' +
      'For the supported aspect ratios, duration, and audio support of each model, ask the AI e.g. "tell me the specs of kling/v3" ' +
      'or run `get_model_info`.',
  );
  return lines.join('\n');
}
