/**
 * Meta-intent guard for generation commands.
 *
 * Background (measured):
 *   Generation commands pass the input string to the CLI **as the generation prompt**.
 *   So writing `/genspark-video list the video models` executes the intent "I want a list of models"
 *   as a video generation, consuming several hundred credits each
 *   (measured on 2026-10-18: about 924 credits for two runs).
 *
 * Policy:
 *   - Only judge commands for generation tools (image_generation / video_generation / audio_generation).
 *   - Target only **meta requests** such as "list models" or "how to use", and let ordinary
 *     generation prompts through (e.g. "a video of a woman who looks like a model" is generated).
 *   - When there are attachments, the generation target is clear, so do not judge.
 *   - Returning a list is safer than a false positive (it spends no credits), so keep
 *     detection narrow and reliable.
 */

/** Generation tools that consume credits. */
const GENERATION_TOOLS = new Set(['image_generation', 'video_generation', 'audio_generation']);

/** Generation tool → model-list kind (corresponds to MODEL_KINDS in lib/models.js). */
const KIND_BY_TOOL = {
  image_generation: 'image',
  video_generation: 'video',
  audio_generation: 'audio',
};

/** Input that asks only about usage (with no surrounding explanation). */
const USAGE_RE = /^(how to use(?: (?:it|this))?|how (?:do|can) (?:i|you) use(?: (?:it|this))?|help|usage|what can (?:you|it|this) do|what does (?:it|this) do)[\s?!.]*$/i;

/** The word "model". */
const MODEL_RE = /\bmodels?\b/i;

/** Words that ask for a list. */
const LIST_RE = /\b(?:list|lists|lineup|kinds?|types?|options?|candidates?|which|what)\b/i;

/** Ask-style request words (do not include "please"; it collides with generation requests). */
const ASK_RE = /\b(?:show|tell|give)(?: me| us)\b|\bwant to (?:see|know)\b|\blet me see\b/i;

/** "Available / selectable" style words. */
const AVAILABLE_RE = /\b(?:available|usable|supported)\b|\bcan (?:i|you) use\b|\bwant to use\b|\b(?:can|could) (?:i|you) (?:choose|select|pick)\b/i;

/** Input that mentions only a model kind (e.g. "video model" / "model"). */
const BARE_RE = /^(image|video|audio|music)?\s*(generation)?\s*(models?)$/i;

/*
 * Japanese matchers.
 *
 * These are written as \uXXXX escapes so the source file stays ASCII-only, but they are
 * **functional**, not decorative: most real inputs are Japanese, and dropping them silently
 * re-opens the credit-burning incident this guard was added for
 * (`/genspark-video` plus the Japanese for "list of video models" was executed as a video generation).
 */

/** Matches "model". */
const JA_MODEL_RE = /\u30e2\u30c7\u30eb/;

/** Matches list / lineup / kind / type / which / what kind. */
const JA_LIST_RE =
  /\u4e00\u89a7|\u30ea\u30b9\u30c8|\u7a2e\u985e|\u30e9\u30a4\u30f3\u30ca\u30c3\u30d7|\u3069\u308c|\u3069\u3093\u306a/;

/** Matches: tell me / show me / I want to know / list them. */
const JA_ASK_RE = /\u6559\u3048\u3066|\u898b\u305b\u3066|\u77e5\u308a\u305f\u3044|\u6319\u3052\u3066/;

/** Matches: can be used / want to use / supported / selectable / available. */
const JA_AVAILABLE_RE = /\u4f7f\u3048\u308b|\u4f7f\u3044\u305f\u3044|\u5bfe\u5fdc|\u9078\u3079\u308b|\u5229\u7528/;

/** Matches "how to use" / "what can it do" / "help" (only when the whole input is one of these). */
const JA_USAGE_RE =
  /^(\u4f7f\u3044\u65b9|\u3069\u3046\u3084\u3063\u3066\u4f7f\u3046|\u4f55\u304c\u3067\u304d\u308b|\u30d8\u30eb\u30d7)[\s?!.\uFF1F\u3002]*$/;

/** Matches "(image|video|audio|music) (generation) models" (only when the whole input is just that). */
const JA_BARE_RE =
  /^(\u753b\u50cf|\u52d5\u753b|\u97f3\u58f0|\u97f3\u697d)?\s*(\u751f\u6210)?\s*(\u30e2\u30c7\u30eb)$/;

/**
 * Whether this is a generation tool.
 * @param {string} tool gsk tool name (e.g. video_generation)
 */
export function isGenerationTool(tool) {
  return GENERATION_TOOLS.has(String(tool ?? ''));
}

/**
 * The model-list kind for a generation tool (undefined when no match).
 * @param {string} tool gsk tool name
 */
export function modelKindOfTool(tool) {
  return KIND_BY_TOOL[String(tool ?? '')];
}

/**
 * Determine whether the input is a meta request rather than a generation request.
 *
 * @param {string} input Raw input of the command
 * @returns {{ kind: 'models' } | { kind: 'usage' } | undefined}
 *   models … wants a model list / usage … wants to know how to use it
 */
export function detectMetaIntent(input) {
  const text = String(input ?? '').trim();
  if (text.length === 0) return undefined;

  if (USAGE_RE.test(text) || JA_USAGE_RE.test(text)) return { kind: 'usage' };

  // Inputs that do not mention models are treated as ordinary generation prompts
  if (!MODEL_RE.test(text) && !JA_MODEL_RE.test(text)) return undefined;

  if (BARE_RE.test(text) || JA_BARE_RE.test(text)) return { kind: 'models' };
  if (LIST_RE.test(text) || JA_LIST_RE.test(text)) return { kind: 'models' };
  if (ASK_RE.test(text) || JA_ASK_RE.test(text)) return { kind: 'models' };
  if (AVAILABLE_RE.test(text) || JA_AVAILABLE_RE.test(text)) return { kind: 'models' };
  return undefined;
}
