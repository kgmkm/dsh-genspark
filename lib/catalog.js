/**
 * 実カタログ（`gsk ls` の出力）の取得・索引・要約。
 *
 * 実測（v1.14.2）: 302 ツール / 46 グループ。`gsk ls` はエンベロープを付けずに
 * `{ tools: ToolSchema[], features?: Record<string, boolean> }` を stdout へ 1 行で出す。
 * 302 ツール全部をモデルへ提示するとコンテキストを圧迫するため、既定は要約のみを返し、
 * 詳細スキーマは keyword 指定時（full=true）にだけ返す。
 */
import { parseEnvelope } from './result.js';

/** グループ key を求める（cli.path があればそれを、無ければ cli.group を使う）。 */
export function groupOf(tool) {
  const cli = tool?.cli ?? {};
  if (Array.isArray(cli.path) && cli.path.length > 0) return cli.path.join(' ');
  if (typeof cli.group === 'string' && cli.group.length > 0) return cli.group;
  return '(ungrouped)';
}

/** キャッシュ付きカタログ取得。 */
export function createCatalogCache({ getConfig, log } = {}) {
  let cache = null; // { tools, features, fetchedAt }

  async function load(runner, { refresh = false, signal, cwd } = {}) {
    const cfg = (typeof getConfig === 'function' ? getConfig() : getConfig) ?? {};
    const ttlMs = Number(cfg.catalogTtlMs ?? 900000);
    if (!refresh && cache && Date.now() - cache.fetchedAt < ttlMs) return { ...cache, cached: true };

    const argv = ['--output', 'json'];
    if (refresh) argv.push('--refresh');
    argv.push('ls');
    const result = await runner.run(argv, { signal, cwd, timeoutMs: cfg.catalogTimeoutMs ?? 120000 });
    const { value } = parseEnvelope(result.stdout);
    if (!value || !Array.isArray(value.tools)) {
      const error = new Error(
        `カタログを取得できませんでした（exit code: ${result.code ?? '不明'}）。` +
          (result.stderr?.trim() ? `\n${result.stderr.trim().slice(0, 800)}` : ''),
      );
      error.code = 'GSK_CATALOG_UNAVAILABLE';
      throw error;
    }
    cache = { tools: value.tools, features: value.features ?? {}, fetchedAt: Date.now() };
    log?.(`[genspark] カタログ取得: ${value.tools.length} ツール`);
    return { ...cache, cached: false };
  }

  return {
    load,
    peek: () => cache,
    clear: () => {
      cache = null;
    },
  };
}

function haystack(tool) {
  const cli = tool.cli ?? {};
  // action 名も検索対象に含める（「send できるツール」を名前で探せるようにするため）
  const actions = tool.actions ? Object.keys(tool.actions) : [];
  return [tool.name, ...(cli.aliases ?? []), groupOf(tool), tool.description ?? '', ...actions]
    .join(' ')
    .toLowerCase();
}

/** keyword（空白区切りの AND）と group で絞り込む。 */
export function filterTools(tools, { keyword, group } = {}) {
  const terms = String(keyword ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const groupTerm = String(group ?? '').toLowerCase();
  return tools.filter((tool) => {
    if (groupTerm.length > 0 && !groupOf(tool).toLowerCase().includes(groupTerm)) return false;
    if (terms.length === 0) return true;
    const text = haystack(tool);
    return terms.every((term) => text.includes(term));
  });
}

/** グループ別の件数一覧（カテゴリ選定とモデルの当たり付けに使う）。 */
export function groupSummary(tools) {
  const counts = new Map();
  for (const tool of tools) counts.set(groupOf(tool), (counts.get(groupOf(tool)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** 1 ツールを 1 行に要約する。 */
export function toolLine(tool) {
  const cli = tool.cli ?? {};
  const aliases = (cli.aliases ?? []).length > 0 ? ` (alias: ${cli.aliases.join(', ')})` : '';
  const actions = tool.actions ? ` [${Object.keys(tool.actions).length} actions]` : '';
  const gated = cli.requires_confirmation ? ' 🔒要承認' : '';
  const interactive = cli.interactive_only ? ' ⚠️対話必須' : '';
  const params = Object.keys(tool.parameters?.properties ?? {});
  const required = new Set(tool.parameters?.required ?? []);
  const paramText =
    params.length === 0
      ? ''
      : ` args: ${params.map((p) => (required.has(p) ? `${p}*` : p)).join(', ')}`;
  const desc = String(tool.description ?? '').split('\n')[0].slice(0, 160);
  return `- ${tool.name}${aliases}${actions}${gated}${interactive} — ${desc}${paramText}`;
}

/** カタログ要約テキストを作る。 */
export function summarizeCatalog(catalog, { keyword, group, limit = 60 } = {}) {
  const tools = catalog.tools ?? [];
  const matched = filterTools(tools, { keyword, group });
  const lines = [];
  lines.push(
    `Genspark ツールカタログ: 全 ${tools.length} ツール / ${groupSummary(tools).length} グループ` +
      (keyword || group ? `（絞り込み: ${[keyword && `keyword="${keyword}"`, group && `group="${group}"`].filter(Boolean).join(' ')} → ${matched.length} 件）` : ''),
  );

  if (!keyword && !group) {
    lines.push('');
    lines.push('## グループ別件数（group 引数にそのまま指定できます）');
    for (const [name, count] of groupSummary(tools)) lines.push(`- ${name}: ${count}`);
    lines.push('');
    lines.push('## よく使う入口（詳細は keyword で絞るか full=true）');
    const highlights = [
      'web_search', 'crawler', 'image_search', 'image_generation', 'video_generation', 'audio_generation',
      'understand_images', 'analyze_media', 'audio_transcribe', 'summarize_large_document', 'aidrive',
      'create_task', 'task_status', 'task_info', 'connector_list', 'connector_tools', 'connector_call',
      'get_model_info', 'stock_price', 'maps_search', 'scholar_search', 'product_search',
    ];
    for (const name of highlights) {
      const tool = tools.find((t) => t.name === name);
      if (tool) lines.push(toolLine(tool));
    }
    lines.push('');
    lines.push('※ 個別ツールの正確な引数は keyword で絞って full=true を指定してください。');
    return lines.join('\n');
  }

  lines.push('');
  for (const tool of matched.slice(0, Math.max(1, Number(limit) || 60))) lines.push(toolLine(tool));
  if (matched.length > limit) lines.push(`… 他 ${matched.length - limit} 件（keyword を追加して絞ってください）`);
  if (matched.length === 0) lines.push('該当なし。group 一覧は引数なしで確認できます。');
  return lines.join('\n');
}

/** 1 ツールの完全な引数スキーマをテキスト化する（full=true 用）。 */
export function describeToolFull(tool) {
  const cli = tool.cli ?? {};
  const lines = [];
  lines.push(`## ${tool.name}`);
  lines.push(tool.description ?? '');
  lines.push(`- group: ${groupOf(tool)} / aliases: ${(cli.aliases ?? []).join(', ') || 'なし'} / requires_project: ${Boolean(tool.requires_project)}`);
  if (cli.requires_confirmation) lines.push('- ⚠️ この操作は確認が必要（承認後に --yes を渡す）');
  if (cli.interactive_only) lines.push('- ⚠️ 対話必須のためプラグインからは実行不可');
  const props = tool.parameters?.properties ?? {};
  const required = new Set(tool.parameters?.required ?? []);
  lines.push('');
  lines.push('parameters (args に渡す JSON のキー):');
  if (Object.keys(props).length === 0) lines.push('- なし');
  for (const [name, spec] of Object.entries(props)) {
    const type = Array.isArray(spec.type) ? spec.type.join('|') : spec.type;
    const enumText = spec.enum ? ` enum=[${spec.enum.join(', ')}]` : '';
    const defaultText = spec.default !== undefined ? ` default=${JSON.stringify(spec.default)}` : '';
    lines.push(`- ${name}${required.has(name) ? ' (必須)' : ''}: ${type}${enumText}${defaultText} — ${spec.description ?? ''}`);
  }
  if (tool.actions && Object.keys(tool.actions).length > 0) {
    lines.push('');
    lines.push('actions (action 引数に指定する値):');
    for (const [name, info] of Object.entries(tool.actions)) {
      const flags = [info.requires_confirmation && '要承認', info.interactive_only && '対話必須'].filter(Boolean).join('/');
      const actionRequired = (info.required ?? []).length > 0 ? ` required=[${info.required.join(', ')}]` : '';
      lines.push(`- ${name}${flags ? ` (${flags})` : ''}: ${info.description}${actionRequired}`);
    }
  }
  return lines.join('\n');
}

/** full=true 用のまとめ。 */
export function describeCatalogFull(catalog, { keyword, group, limit = 12 } = {}) {
  const matched = filterTools(catalog.tools ?? [], { keyword, group });
  if (matched.length === 0) return '該当ツールなし。';
  const head = `該当 ${matched.length} 件のうち ${Math.min(matched.length, limit)} 件の完全スキーマ:\n`;
  return head + matched.slice(0, limit).map(describeToolFull).join('\n\n');
}
