/**
 * Fetching, indexing, and summarizing the actual catalog (the output of `gsk ls`).
 *
 * Measured (v1.14.2): 302 tools / 46 groups. `gsk ls` outputs
 * `{ tools: ToolSchema[], features?: Record<string, boolean> }` to stdout on one line, without an envelope.
 * Presenting all 302 tools to the model would pressure the context, so the default returns only a summary;
 * the detailed schema is returned only when a keyword is specified (full=true).
 */
import { parseEnvelope } from './result.js';

/** Determine the group key (use cli.path if present, otherwise cli.group). */
export function groupOf(tool) {
  const cli = tool?.cli ?? {};
  if (Array.isArray(cli.path) && cli.path.length > 0) return cli.path.join(' ');
  if (typeof cli.group === 'string' && cli.group.length > 0) return cli.group;
  return '(ungrouped)';
}

/**
 * Build the CLI's canonical command name (including grouped commands such as `gsk social twitter`).
 *
 * The rules are the same as the CLI's own command registration (`@genspark/cli` dist/index.js:
 * `canonical = hasPath ? "gsk <path>" : group ? "gsk <group> <sub>" : "gsk <name>"`):
 *   - If `cli.path` exists, use it as is (`task create` / `telephony call dial`, etc.)
 *   - If `cli.group` exists, `<group> <subcommand|name with group_ stripped>`
 *   - If neither exists, the tool name is the command as is
 *
 * Examples: social_twitter → ['social','twitter'] / x_search_tweets → ['x','search_tweets'] /
 *     web_search → ['web_search'] / create_task → ['task','create']
 */
export function toolInvocation(tool) {
  const cli = tool?.cli ?? {};
  const name = typeof tool?.name === 'string' ? tool.name : '';
  if (Array.isArray(cli.path) && cli.path.length >= 2) return cli.path.map(String);
  if (typeof cli.group === 'string' && cli.group.length > 0) {
    const group = cli.group;
    const explicit = typeof cli.subcommand === 'string' && cli.subcommand.length > 0 ? cli.subcommand : undefined;
    const sub = explicit ?? (name.startsWith(`${group}_`) ? name.slice(group.length + 1) : name);
    return sub.length > 0 ? [group, sub] : [group];
  }
  return name.length > 0 ? [name] : [];
}

/** Command string for display (`gsk social twitter`). */
export function invocationLabel(tool) {
  const segments = toolInvocation(tool);
  return segments.length === 0 ? '(unknown)' : `gsk ${segments.join(' ')}`;
}

/** Catalog fetch with caching. */
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
        `Could not retrieve the catalog (exit code: ${result.code ?? 'unknown'}).` +
          (result.stderr?.trim() ? `\n${result.stderr.trim().slice(0, 800)}` : ''),
      );
      error.code = 'GSK_CATALOG_UNAVAILABLE';
      throw error;
    }
    cache = { tools: value.tools, features: value.features ?? {}, fetchedAt: Date.now() };
    log?.(`[genspark] catalog fetched: ${value.tools.length} tools`);
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
  // Include action names in the search target as well (so that tools that can "send" can be found by name)
  const actions = tool.actions ? Object.keys(tool.actions) : [];
  return [tool.name, ...(cli.aliases ?? []), groupOf(tool), tool.description ?? '', ...actions]
    .join(' ')
    .toLowerCase();
}

/** Filter by keyword (space-separated AND) and group. */
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

/** List of counts per group (used for category selection and for targeting models). */
export function groupSummary(tools) {
  const counts = new Map();
  for (const tool of tools) counts.set(groupOf(tool), (counts.get(groupOf(tool)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Summarize one tool in one line. */
export function toolLine(tool) {
  const cli = tool.cli ?? {};
  const aliases = (cli.aliases ?? []).length > 0 ? ` (alias: ${cli.aliases.join(', ')})` : '';
  const actions = tool.actions ? ` [${Object.keys(tool.actions).length} actions]` : '';
  const gated = cli.requires_confirmation ? ' 🔒approval required' : '';
  const interactive = cli.interactive_only ? ' ⚠️interactive only' : '';
  const params = Object.keys(tool.parameters?.properties ?? {});
  const required = new Set(tool.parameters?.required ?? []);
  const paramText =
    params.length === 0
      ? ''
      : ` args: ${params.map((p) => (required.has(p) ? `${p}*` : p)).join(', ')}`;
  const desc = String(tool.description ?? '').split('\n')[0].slice(0, 160);
  return `- ${tool.name}${aliases}${actions}${gated}${interactive} — ${desc}${paramText}`;
}

/** Build the catalog summary text. */
export function summarizeCatalog(catalog, { keyword, group, limit = 60 } = {}) {
  const tools = catalog.tools ?? [];
  const matched = filterTools(tools, { keyword, group });
  const lines = [];
  lines.push(
    `Genspark tool catalog: ${tools.length} tools in total / ${groupSummary(tools).length} groups` +
      (keyword || group ? ` (filter: ${[keyword && `keyword="${keyword}"`, group && `group="${group}"`].filter(Boolean).join(' ')} → ${matched.length} matches)` : ''),
  );

  if (!keyword && !group) {
    lines.push('');
    lines.push('## Counts by group (each can be passed directly to the group argument)');
    for (const [name, count] of groupSummary(tools)) lines.push(`- ${name}: ${count}`);
    lines.push('');
    lines.push('## Common entry points (narrow with keyword, or use full=true, for details)');
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
    lines.push('Note: for the exact arguments of an individual tool, filter by keyword and specify full=true.');
    return lines.join('\n');
  }

  lines.push('');
  for (const tool of matched.slice(0, Math.max(1, Number(limit) || 60))) lines.push(toolLine(tool));
  if (matched.length > limit) lines.push(`… ${matched.length - limit} more (add a keyword to narrow the results)`);
  if (matched.length === 0) lines.push('No matches. The group list is available with no arguments.');
  return lines.join('\n');
}

/** Render the complete argument schema of one tool as text (for full=true). */
export function describeToolFull(tool) {
  const cli = tool.cli ?? {};
  const lines = [];
  lines.push(`## ${tool.name}`);
  lines.push(tool.description ?? '');
  lines.push(`- group: ${groupOf(tool)} / aliases: ${(cli.aliases ?? []).join(', ') || 'none'} / requires_project: ${Boolean(tool.requires_project)}`);
  lines.push(`- Run: ${invocationLabel(tool)}`);
  if (cli.requires_confirmation) lines.push('- ⚠️ This operation requires confirmation (pass --yes after approval)');
  if (cli.interactive_only) lines.push('- ⚠️ Interactive only, so it cannot be run from the plugin');
  const props = tool.parameters?.properties ?? {};
  const required = new Set(tool.parameters?.required ?? []);
  lines.push('');
  lines.push('parameters (keys of the JSON passed in args):');
  if (Object.keys(props).length === 0) lines.push('- none');
  for (const [name, spec] of Object.entries(props)) {
    const type = Array.isArray(spec.type) ? spec.type.join('|') : spec.type;
    const enumText = spec.enum ? ` enum=[${spec.enum.join(', ')}]` : '';
    const defaultText = spec.default !== undefined ? ` default=${JSON.stringify(spec.default)}` : '';
    lines.push(`- ${name}${required.has(name) ? ' (required)' : ''}: ${type}${enumText}${defaultText} — ${spec.description ?? ''}`);
  }
  if (tool.actions && Object.keys(tool.actions).length > 0) {
    lines.push('');
    lines.push('actions (values specified in the action argument):');
    for (const [name, info] of Object.entries(tool.actions)) {
      const flags = [info.requires_confirmation && 'approval required', info.interactive_only && 'interactive only'].filter(Boolean).join('/');
      const actionRequired = (info.required ?? []).length > 0 ? ` required=[${info.required.join(', ')}]` : '';
      lines.push(`- ${name}${flags ? ` (${flags})` : ''}: ${info.description}${actionRequired}`);
    }
  }
  return lines.join('\n');
}

/** Summary for full=true. */
export function describeCatalogFull(catalog, { keyword, group, limit = 12 } = {}) {
  const matched = filterTools(catalog.tools ?? [], { keyword, group });
  if (matched.length === 0) return 'No matching tools.';
  const head = `Complete schemas for ${Math.min(matched.length, limit)} of ${matched.length} matching tools:\n`;
  return head + matched.slice(0, limit).map(describeToolFull).join('\n\n');
}
